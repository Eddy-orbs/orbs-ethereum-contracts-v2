// SPDX-License-Identifier: MIT

pragma solidity 0.6.12;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/math/Math.sol";
import "@openzeppelin/contracts/math/SafeMath.sol";

import "./spec_interfaces/IMigratableFeesWallet.sol";
import "./spec_interfaces/IFeesWallet.sol";
import "./ManagedContract.sol";

/// @title Fees Wallet contract interface, manages the fee buckets
contract FeesWallet is IFeesWallet, ManagedContract {
    using SafeMath for uint256;

    uint256 constant BUCKET_TIME_PERIOD = 30 days;
    uint constant MAX_FEE_BUCKET_ITERATIONS = 24;

    IERC20 public token;
    mapping(uint256 => uint256) public buckets;
    uint256 public lastCollectedAt;

    /// Constructor
    /// @param _contractRegistry is the contract registry address
    /// @param _registryAdmin is the registry admin address
    /// @param _token is the token used for virtual chains fees 
    constructor(IContractRegistry _contractRegistry, address _registryAdmin, IERC20 _token) ManagedContract(_contractRegistry, _registryAdmin) public {
        token = _token;
        lastCollectedAt = block.timestamp;
    }

    modifier onlyRewardsContract() {
        require(msg.sender == rewardsContract, "caller is not the rewards contract");

        _;
    }

    /*
     *   External methods
     */

    /// Top-ups the fee pool with the given amount at the given rate
    /// @dev Called by: subscriptions contract. (not enforced)
    /// @dev fills the rewards in 30 days buckets based on the monthlyRate
    /// @param amount is the amount to fill
    /// @param monthlyRate is the monthly rate
    /// @param fromTimestamp is the to start fill the buckets, determines the first bucket to fill and the amount filled in the first bucket.
    function fillFeeBuckets(uint256 amount, uint256 monthlyRate, uint256 fromTimestamp) external override onlyWhenActive {
        uint256 bucket = _bucketTime(fromTimestamp);
        require(bucket >= _bucketTime(block.timestamp), "FeeWallet::cannot fill bucket from the past");

        uint256 _amount = amount;

        // add the partial amount to the first bucket
        uint256 bucketAmount = Math.min(amount, monthlyRate.mul(BUCKET_TIME_PERIOD.sub(fromTimestamp % BUCKET_TIME_PERIOD)).div(BUCKET_TIME_PERIOD));
        fillFeeBucket(bucket, bucketAmount);
        _amount = _amount.sub(bucketAmount);

        // following buckets are added with the monthly rate
        while (_amount > 0) {
            bucket = bucket.add(BUCKET_TIME_PERIOD);
            bucketAmount = Math.min(monthlyRate, _amount);
            fillFeeBucket(bucket, bucketAmount);

            _amount = _amount.sub(bucketAmount);
        }

        require(token.transferFrom(msg.sender, address(this), amount), "failed to transfer fees into fee wallet");
    }

    /// Collect fees from the buckets since the last call and transfers the amount back.
    /// @dev Called by: only FeesAndBootstrapRewards contract
    /// @dev The amount to collect may be queried before collect by calling getOutstandingFees
    /// @return collectedFees the amount of fees collected and transferred
    function collectFees() external override onlyRewardsContract returns (uint256 collectedFees)  {
        (uint256 _collectedFees, uint[] memory bucketsWithdrawn, uint[] memory amountsWithdrawn, uint[] memory newTotals) = _getOutstandingFees(block.timestamp);

        for (uint i = 0; i < bucketsWithdrawn.length; i++) {
            buckets[bucketsWithdrawn[i]] = newTotals[i];
            emit FeesWithdrawnFromBucket(bucketsWithdrawn[i], amountsWithdrawn[i], newTotals[i]);
        }

        lastCollectedAt = block.timestamp;

        require(token.transfer(msg.sender, _collectedFees), "FeesWallet::failed to transfer collected fees to rewards"); // TODO in that case, transfer the remaining balance?
        return _collectedFees;
    }

    /// Returns the amount of fees that are currently available for withdrawal
    /// @param currentTime is the time to check the pending fees for
    /// @return outstandingFees is the amount of pending fees to collect at time currentTime
    function getOutstandingFees(uint256 currentTime) external override view returns (uint256 outstandingFees)  {
        require(currentTime >= block.timestamp, "currentTime must not be in the past");
        (outstandingFees,,,) = _getOutstandingFees(currentTime);
    }

    /*
     * Governance functions
     */

    /// Migrates the fees of a bucket starting at startTimestamp.
    /// @dev governance function called only by the migration manager
    /// @dev Calls acceptBucketMigration in the destination contract.
    /// @param destination is the address of the new FeesWallet contract
    /// @param bucketStartTime is the start time of the bucket to migration, must be a bucket's valid start time
    function migrateBucket(IMigratableFeesWallet destination, uint256 bucketStartTime) external override onlyMigrationManager {
        require(_bucketTime(bucketStartTime) == bucketStartTime,  "bucketStartTime must be the  start time of a bucket");

        uint bucketAmount = buckets[bucketStartTime];
        if (bucketAmount == 0) return;

        buckets[bucketStartTime] = 0;
        emit FeesWithdrawnFromBucket(bucketStartTime, bucketAmount, 0);

        token.approve(address(destination), bucketAmount);
        destination.acceptBucketMigration(bucketStartTime, bucketAmount);
    }

    /// Accepts a fees bucket balance from a previous fees wallet as part of the fees wallet migration
    /// @dev Called by the old FeesWallet contract.
    /// @dev Part of the IMigratableFeesWallet interface.
    /// @dev assumes the caller approved the amount prior to calling
    /// @param bucketStartTime is the start time of the bucket to migration, must be a bucket's valid start time
    /// @param amount is the amount to migrate (transfer) to the bucket
    function acceptBucketMigration(uint256 bucketStartTime, uint256 amount) external override {
        require(_bucketTime(bucketStartTime) == bucketStartTime,  "bucketStartTime must be the  start time of a bucket");
        fillFeeBucket(bucketStartTime, amount);
        require(token.transferFrom(msg.sender, address(this), amount), "failed to transfer fees into fee wallet on bucket migration");
    }

    /// Emergency withdraw the contract funds
    /// @dev governance function called only by the migration manager
    /// @dev used in emergencies only, where migrateBucket is not a suitable solution
    /// @param erc20 is the erc20 address of the token to withdraw
    function emergencyWithdraw(address erc20) external override onlyMigrationManager {
        IERC20 _token = IERC20(erc20);
        emit EmergencyWithdrawal(msg.sender, address(_token));
        require(_token.transfer(msg.sender, _token.balanceOf(address(this))), "FeesWallet::emergencyWithdraw - transfer failed");
    }

    /*
    * Private methods
    */

    /// Fills a bucket with the given amount and emits a corresponding event
    function fillFeeBucket(uint256 bucketId, uint256 amount) private {
        uint256 bucketTotal = buckets[bucketId].add(amount);
        buckets[bucketId] = bucketTotal;
        emit FeesAddedToBucket(bucketId, amount, bucketTotal);
    }

    /// Returns the amount of fees that are currently available for withdrawal
    /// Private function utilized by collectFees and getOutstandingFees
    /// @dev the buckets details returned by the function are used for the corresponding events generation
    /// @param currentTime is the time to check the pending fees for
    /// @return outstandingFees is the amount of pending fees to collect at time currentTime 
    /// @return bucketsWithdrawn is the list of buckets that fees were withdrawn from
    /// @return withdrawnAmounts is the list of amounts withdrawn from the buckets
    /// @return newTotals is the updated total of the buckets
    function _getOutstandingFees(uint256 currentTime) private view returns (uint256 outstandingFees, uint[] memory bucketsWithdrawn, uint[] memory withdrawnAmounts, uint[] memory newTotals)  {
        // TODO we often do integer division for rate related calculation, which floors the result. Do we need to address this?
        // TODO for an empty committee or a committee with 0 total stake the divided amounts will be locked in the contract FOREVER

        // Fee pool
        uint _lastCollectedAt = lastCollectedAt;
        uint nUpdatedBuckets = _bucketTime(currentTime).sub(_bucketTime(_lastCollectedAt)).div(BUCKET_TIME_PERIOD).add(1);
        bucketsWithdrawn = new uint[](nUpdatedBuckets);
        withdrawnAmounts = new uint[](nUpdatedBuckets);
        newTotals = new uint[](nUpdatedBuckets);
        uint bucketsPayed = 0;
        while (bucketsPayed < MAX_FEE_BUCKET_ITERATIONS && _lastCollectedAt < currentTime) {
            uint256 bucketStart = _bucketTime(_lastCollectedAt);
            uint256 bucketEnd = bucketStart.add(BUCKET_TIME_PERIOD);
            uint256 payUntil = Math.min(bucketEnd, currentTime);
            uint256 bucketDuration = payUntil.sub(_lastCollectedAt);
            uint256 remainingBucketTime = bucketEnd.sub(_lastCollectedAt);

            uint256 bucketTotal = buckets[bucketStart];
            uint256 amount = bucketTotal.mul(bucketDuration).div(remainingBucketTime);
            outstandingFees = outstandingFees.add(amount);
            bucketTotal = bucketTotal.sub(amount);

            bucketsWithdrawn[bucketsPayed] = bucketStart;
            withdrawnAmounts[bucketsPayed] = amount;
            newTotals[bucketsPayed] = bucketTotal;

            _lastCollectedAt = payUntil;
            bucketsPayed++;
        }
    }

    /// Returns the start time of a bucket, used also to identify the bucket
    function _bucketTime(uint256 time) private pure returns (uint256) {
        return time.sub(time % BUCKET_TIME_PERIOD);
    }

    /*
     * Contracts topology / registry interface
     */

    address rewardsContract;

    /// Refreshes the address of the other contracts the contract interacts with
    /// @dev called by the registry contract upon an update of a contract in the registry
    function refreshContracts() external override {
        rewardsContract = getFeesAndBootstrapRewardsContract();
    }
}

// SPDX-License-Identifier: UNLICENSED

pragma solidity 0.6.12;

import "@openzeppelin/contracts/math/SafeMath.sol";
import "@openzeppelin/contracts/math/Math.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import "./spec_interfaces/IContractRegistry.sol";
import "./spec_interfaces/ICommittee.sol";
import "./spec_interfaces/IProtocolWallet.sol";
import "./ContractRegistryAccessor.sol";
import "./Erc20AccessorWithTokenGranularity.sol";
import "./spec_interfaces/IFeesWallet.sol";
import "./Lockable.sol";
import "./ManagedContract.sol";
import "./SafeMath48.sol";

contract Rewards is IRewards, ERC20AccessorWithTokenGranularity, ManagedContract {
    using SafeMath for uint256;
    using SafeMath for uint96;
    using SafeMath48 for uint48;

    struct Settings {
        uint48 generalCommitteeAnnualBootstrap;
        uint48 certifiedCommitteeAnnualBootstrap;
        uint48 annualCap;
        uint32 annualRateInPercentMille;
        uint32 maxDelegatorsStakingRewardsPercentMille;
        bool active;
    }
    Settings settings;

    IERC20 bootstrapToken;
    IERC20 erc20;

    struct StakingRewardsTotals {
        uint96 stakingRewardsPerToken;
        uint32 lastAssigned;
    }

    StakingRewardsTotals stakingRewardsTotals;

    struct CommitteeTotalsPerMember {
        uint48 certifiedFees;
        uint48 generalFees;
        uint48 certifiedBootstrap;
        uint48 generalBootstrap;
        uint32 lastAssigned;
    }
    CommitteeTotalsPerMember committeeTotalsPerMember;

    struct StakingRewardsBalance {
        uint96 delegatorRewardsPerToken;
        uint96 lastRewardsPerToken;
        uint48 balance;
    }
    mapping(address => StakingRewardsBalance) stakingRewardsBalances;

    struct CommitteeBalance {
        uint48 feeBalance;
        uint48 lastFeePerMember;
        uint48 bootstrapBalance;
        uint48 lastBootstrapPerMember;
    }
    mapping(address => CommitteeBalance) committeeBalances;

	uint32 constant PERCENT_MILLIE_BASE = 100000;

    uint256 lastAssignedAt;

    modifier onlyCommitteeContract() {
        require(msg.sender == address(committeeContract), "caller is not the committee contract");

        _;
    }

    uint constant TOKEN_BASE = 1e18;

    function calcStakingRewardPerTokenDelta(uint256 totalCommitteeStake, uint duration, Settings memory _settings) private pure returns (uint256 stakingRewardsPerTokenDelta) {
        stakingRewardsPerTokenDelta = 0;

        if (totalCommitteeStake > 0) { // TODO - handle the case of totalStake == 0. consider also an empty committee. consider returning a boolean saying if the amount was successfully distributed or not and handle on caller side.
            uint annualRateInPercentMille = Math.min(uint(_settings.annualRateInPercentMille), toUint256Granularity(_settings.annualCap).mul(PERCENT_MILLIE_BASE).div(totalCommitteeStake));
            stakingRewardsPerTokenDelta = annualRateInPercentMille.mul(TOKEN_BASE).mul(duration).div(uint(PERCENT_MILLIE_BASE).mul(365 days));
        }
    }

    function updateStakingRewardsTotals(uint256 totalCommitteeStake) private returns (StakingRewardsTotals memory totals){
        totals = stakingRewardsTotals;
        if (settings.active) {
            totals.stakingRewardsPerToken = uint96(uint256(totals.stakingRewardsPerToken).add(calcStakingRewardPerTokenDelta(totalCommitteeStake, block.timestamp - totals.lastAssigned, settings)));
            totals.lastAssigned = uint32(block.timestamp);
            stakingRewardsTotals = totals;
        }
    }

    function committeeMemberStakeWillChange(address guardian, uint256 stake, uint256 totalCommitteeStake, address delegator, uint256 delegatorStake) external override onlyCommitteeContract {
        _updateDelegatorStakingRewards(delegator, delegatorStake, guardian, true, stake, totalCommitteeStake);
    }

    function _updateDelegatorStakingRewards(address delegator, uint256 delegatorStake, address delegate, bool inCommittee, uint256 guardianStake, uint256 totalCommitteeStake) private {
        StakingRewardsBalance memory delegateBalance = _updateGuardianStakingRewardsPerToken(delegate, inCommittee, guardianStake, totalCommitteeStake);
        StakingRewardsBalance memory delegatorBalance = delegator == delegate ? delegateBalance : stakingRewardsBalances[delegator];

        uint256 amount = uint256(delegateBalance.delegatorRewardsPerToken)
            .sub(uint256(delegatorBalance.lastRewardsPerToken))
            .mul(delegatorStake)
            .div(TOKEN_BASE);

        uint delegatorAmount = amount.mul(settings.maxDelegatorsStakingRewardsPercentMille).div(PERCENT_MILLIE_BASE);
        uint delegateAmount = amount.sub(delegatorAmount);

        delegateBalance.balance = delegateBalance.balance.add(toUint48Granularity(delegateAmount));
        delegatorBalance.balance = delegatorBalance.balance.add(toUint48Granularity(delegatorAmount));
        delegatorBalance.lastRewardsPerToken = delegateBalance.delegatorRewardsPerToken;

        if (delegator == delegate) {
            delegateAmount = delegateAmount.add(delegatorAmount);
            delegatorAmount = 0;
        }

        if (delegateAmount > 0) {
            emit StakingRewardsAssigned(delegate, delegateAmount);
        }

        if (delegatorAmount > 0) {
            emit StakingRewardsAssigned(delegate, delegatorAmount);
        }

        stakingRewardsBalances[delegate] = delegateBalance;
        if (delegate != delegator) stakingRewardsBalances[delegator] = delegatorBalance;
    }

    function _updateGuardianStakingRewardsPerToken(address guardian, bool inCommittee, uint256 guardianStake, uint256 totalCommitteeStake) private returns (StakingRewardsBalance memory guardianBalance){
        StakingRewardsTotals memory totals = updateStakingRewardsTotals(totalCommitteeStake);
        guardianBalance = stakingRewardsBalances[guardian];

        if (inCommittee) {
            uint256 amount = uint256(totals.stakingRewardsPerToken)
                .sub(uint256(guardianBalance.lastRewardsPerToken))
                .mul(guardianStake)
                .div(TOKEN_BASE);
            guardianBalance.delegatorRewardsPerToken = uint96(guardianBalance.delegatorRewardsPerToken.add(amount));
        }

        return guardianBalance;
    }

    function updateDelegatorStakingRewards(address delegator) private {
        ICommittee _committee = committeeContract;
        uint256 delegatorStake = stakingContract.getStakeBalanceOf(delegator);
        address guardian = delegationsContract.getDelegation(delegator);
        (, , uint totalCommitteeStake) = _committee.getCommitteeStats();
        (bool inCommittee, uint guardianStake,) = _committee.getMemberInfo(guardian);
        _updateDelegatorStakingRewards(delegator, delegatorStake, guardian, inCommittee, guardianStake, totalCommitteeStake);
    }

    function updateCommitteeTotalsPerMember(uint generalCommitteeSize, uint certifiedCommitteeSize) private returns (CommitteeTotalsPerMember memory totals) {
        Settings memory _settings = settings;

        totals = committeeTotalsPerMember;

        if (_settings.active) {
            totals.generalFees = totals.generalFees.add(toUint48Granularity(generalFeesWallet.collectFees().div(generalCommitteeSize)));
            totals.certifiedFees = totals.certifiedFees.add(toUint48Granularity(certifiedFeesWallet.collectFees().div(certifiedCommitteeSize)));

            uint duration = now.sub(lastAssignedAt);

            uint48 generalDelta = uint48(uint(_settings.generalCommitteeAnnualBootstrap).mul(duration).div(365 days));
            uint48 certifiedDelta = uint48(uint(_settings.certifiedCommitteeAnnualBootstrap).mul(duration).div(365 days));
            totals.generalBootstrap = totals.generalBootstrap.add(generalDelta);
            totals.certifiedBootstrap = totals.certifiedBootstrap.add(generalDelta).add(certifiedDelta);
            totals.lastAssigned = uint32(block.timestamp);

            committeeTotalsPerMember = totals;
        }
    }

    function _updateGuardianFeesAndBootstrap(address addr, bool inCommittee, bool isCertified, uint generalCommitteeSize, uint certifiedCommitteeSize) private {
        CommitteeTotalsPerMember memory totals = updateCommitteeTotalsPerMember(generalCommitteeSize, certifiedCommitteeSize);
        CommitteeBalance memory balance = committeeBalances[addr];

        if (inCommittee) {
            uint256 totalBootstrap = isCertified ? totals.certifiedBootstrap : totals.generalBootstrap;
            uint256 bootstrapAmount = totalBootstrap.sub(balance.lastBootstrapPerMember);
            balance.bootstrapBalance = balance.bootstrapBalance.add(toUint48Granularity(bootstrapAmount));
            emit BootstrapRewardsAssigned(addr, bootstrapAmount);
            
            uint256 totalFees = isCertified ? totals.certifiedFees : totals.generalFees;
            uint256 feesAmount = totalFees.sub(balance.lastFeePerMember);
            balance.feeBalance = balance.bootstrapBalance.add(toUint48Granularity(feesAmount));
            emit FeesAssigned(addr, feesAmount);
        }
        
        balance.lastBootstrapPerMember = isCertified ? totals.certifiedBootstrap : totals.generalBootstrap;
        balance.lastFeePerMember = isCertified ? totals.certifiedFees : totals.generalFees;
    }

    function updateMemberFeesAndBootstrap(address guardian) private {
        ICommittee _committee = committeeContract;
        (uint generalCommitteeSize, uint certifiedCommitteeSize, ) = _committee.getCommitteeStats();
        (bool inCommittee, , bool certified) = _committee.getMemberInfo(guardian);
        _updateGuardianFeesAndBootstrap(guardian, inCommittee, certified, generalCommitteeSize, certifiedCommitteeSize);
    }

    function committeeMembershipWillChange(address guardian, uint256 stake, uint256 totalCommitteeStake, bool inCommittee, bool isCertified, uint generalCommitteeSize, uint certifiedCommitteeSize) external override onlyCommitteeContract {
        _updateGuardianFeesAndBootstrap(guardian, inCommittee, isCertified, generalCommitteeSize, certifiedCommitteeSize);
        stakingRewardsBalances[guardian] = _updateGuardianStakingRewardsPerToken(guardian, inCommittee, stake, totalCommitteeStake);
    }

    constructor(
        IContractRegistry _contractRegistry,
        address _registryAdmin,
        IERC20 _erc20,
        IERC20 _bootstrapToken,
        uint generalCommitteeAnnualBootstrap,
        uint certifiedCommitteeAnnualBootstrap,
        uint annualRateInPercentMille,
        uint annualCap,
        uint32 maxDelegatorsStakingRewardsPercentMille
    ) ManagedContract(_contractRegistry, _registryAdmin) public {
        require(address(_bootstrapToken) != address(0), "bootstrapToken must not be 0");
        require(address(_erc20) != address(0), "erc20 must not be 0");

        setGeneralCommitteeAnnualBootstrap(generalCommitteeAnnualBootstrap);
        setCertifiedCommitteeAnnualBootstrap(certifiedCommitteeAnnualBootstrap);
        setAnnualStakingRewardsRate(annualRateInPercentMille, annualCap);
        setMaxDelegatorsStakingRewardsPercentMille(maxDelegatorsStakingRewardsPercentMille);

        erc20 = _erc20;
        bootstrapToken = _bootstrapToken;

        // TODO - The initial lastPayedAt should be set in the first assignRewards.
        lastAssignedAt = now;
    }

    // bootstrap rewards

    function setGeneralCommitteeAnnualBootstrap(uint256 annualAmount) public override onlyFunctionalManager onlyWhenActive {
        settings.generalCommitteeAnnualBootstrap = toUint48Granularity(annualAmount);
        emit GeneralCommitteeAnnualBootstrapChanged(annualAmount);
    }

    function setCertifiedCommitteeAnnualBootstrap(uint256 annualAmount) public override onlyFunctionalManager onlyWhenActive {
        settings.certifiedCommitteeAnnualBootstrap = toUint48Granularity(annualAmount);
        emit CertifiedCommitteeAnnualBootstrapChanged(annualAmount);
    }

    function setMaxDelegatorsStakingRewardsPercentMille(uint32 maxDelegatorsStakingRewardsPercentMille) public override onlyFunctionalManager onlyWhenActive {
        require(maxDelegatorsStakingRewardsPercentMille <= PERCENT_MILLIE_BASE, "maxDelegatorsStakingRewardsPercentMille must not be larger than 100000");
        settings.maxDelegatorsStakingRewardsPercentMille = maxDelegatorsStakingRewardsPercentMille;
        emit MaxDelegatorsStakingRewardsChanged(maxDelegatorsStakingRewardsPercentMille);
    }

    function getGeneralCommitteeAnnualBootstrap() external override view returns (uint256) {
        return toUint256Granularity(settings.generalCommitteeAnnualBootstrap);
    }

    function getCertifiedCommitteeAnnualBootstrap() external override view returns (uint256) {
        return toUint256Granularity(settings.certifiedCommitteeAnnualBootstrap);
    }

    function getMaxDelegatorsStakingRewardsPercentMille() public override view returns (uint32) {
        return settings.maxDelegatorsStakingRewardsPercentMille;
    }

    function getAnnualStakingRewardsRatePercentMille() external override view returns (uint32) {
        return settings.annualRateInPercentMille;
    }

    function getAnnualStakingRewardsCap() external override view returns (uint256) {
        return toUint256Granularity(settings.annualCap);
    }

    function getBootstrapBalance(address addr) external override view returns (uint256) {
        return toUint256Granularity(committeeBalances[addr].bootstrapBalance);
    }

    function withdrawBootstrapFunds(address guardian) external override {
        updateMemberFeesAndBootstrap(guardian);
        uint48 amount = committeeBalances[guardian].bootstrapBalance;
        committeeBalances[guardian].bootstrapBalance = 0;
        emit BootstrapRewardsWithdrawn(guardian, toUint256Granularity(amount));

        bootstrapRewardsWallet.withdraw(amount);
        require(transfer(bootstrapToken, guardian, amount), "Rewards::withdrawBootstrapFunds - insufficient funds");
    }

    // staking rewards

    function setAnnualStakingRewardsRate(uint256 annualRateInPercentMille, uint256 annualCap) public override onlyFunctionalManager onlyWhenActive {
        Settings memory _settings = settings;
        _settings.annualRateInPercentMille = uint32(annualRateInPercentMille);
        _settings.annualCap = toUint48Granularity(annualCap);
        settings = _settings;

        emit AnnualStakingRewardsRateChanged(annualRateInPercentMille, annualCap);
    }

    function getStakingRewardBalance(address addr) external override view returns (uint256) {
        return toUint256Granularity(stakingRewardsBalances[addr].balance);
    }

    struct DistributorBatchState {
        uint256 fromBlock;
        uint256 toBlock;
        uint256 nextTxIndex;
        uint split;
    }
    mapping (address => DistributorBatchState) public distributorBatchState;

    function isDelegatorRewardsBelowThreshold(uint256 delegatorRewards, uint256 totalRewards) private view returns (bool) {
        return delegatorRewards.mul(PERCENT_MILLIE_BASE) <= uint(settings.maxDelegatorsStakingRewardsPercentMille).mul(totalRewards.add(toUint256Granularity(1))); // +1 is added to account for rounding errors
    }

    struct distributeStakingRewardsVars {
        bool firstTxBySender;
        address guardianAddr;
        uint256 delegatorsAmount;
    }
    function distributeStakingRewards(uint256 totalAmount, uint256 fromBlock, uint256 toBlock, uint split, uint txIndex, address[] calldata to, uint256[] calldata amounts) external override onlyWhenActive {
        require(to.length > 0, "list must contain at least one recipient");
        require(to.length == amounts.length, "expected to and amounts to be of same length");
        uint48 totalAmount_uint48 = toUint48Granularity(totalAmount);
        require(totalAmount == toUint256Granularity(totalAmount_uint48), "totalAmount must divide by 1e15");

        distributeStakingRewardsVars memory vars;

        vars.guardianAddr = guardianRegistrationContract.resolveGuardianAddress(msg.sender);

        if (txIndex == 0) {
            updateDelegatorStakingRewards(vars.guardianAddr);
        }

        for (uint i = 0; i < to.length; i++) {
            if (to[i] != vars.guardianAddr) {
                vars.delegatorsAmount = vars.delegatorsAmount.add(amounts[i]);
            }
        }
        require(isDelegatorRewardsBelowThreshold(vars.delegatorsAmount, totalAmount), "Total delegators reward must be less then maxDelegatorsStakingRewardsPercentMille of total amount");

        DistributorBatchState memory ds = distributorBatchState[vars.guardianAddr];
        vars.firstTxBySender = ds.nextTxIndex == 0;

        if (vars.firstTxBySender || fromBlock == ds.toBlock + 1) { // New distribution batch
            require(vars.firstTxBySender || txIndex == 0, "txIndex must be 0 for the first transaction of a new (non-initial) distribution batch");
            require(toBlock < block.number, "toBlock must be in the past");
            require(toBlock >= fromBlock, "toBlock must be at least fromBlock");
            ds.fromBlock = fromBlock;
            ds.toBlock = toBlock;
            ds.split = split;
            ds.nextTxIndex = txIndex + 1;
            distributorBatchState[vars.guardianAddr] = ds;
        } else {
            require(fromBlock == ds.fromBlock, "fromBlock mismatch");
            require(toBlock == ds.toBlock, "toBlock mismatch");
            require(txIndex == ds.nextTxIndex, "txIndex mismatch");
            require(split == ds.split, "split mismatch");
            distributorBatchState[vars.guardianAddr].nextTxIndex = txIndex + 1;
        }

        require(totalAmount_uint48 <= stakingRewardsBalances[vars.guardianAddr].balance, "not enough member balance for this distribution");

        stakingRewardsBalances[vars.guardianAddr].balance = uint48(stakingRewardsBalances[vars.guardianAddr].balance.sub(totalAmount_uint48));

        IStakingContract _stakingContract = stakingContract;

        stakingRewardsWallet.withdraw(totalAmount);

        approve(erc20, address(_stakingContract), totalAmount_uint48);
        _stakingContract.distributeRewards(totalAmount, to, amounts); // TODO should we rely on staking contract to verify total amount?

        delegationsContract.refreshStakeNotification(vars.guardianAddr);

        emit StakingRewardsDistributed(vars.guardianAddr, fromBlock, toBlock, split, txIndex, to, amounts);
    }

    function getFeeBalance(address addr) external override view returns (uint256) {
        return toUint256Granularity(committeeBalances[addr].feeBalance);
    }

    function withdrawFees(address guardian) external override {
        ICommittee _committee = committeeContract;
        (uint generalCommitteeSize, uint certifiedCommitteeSize, ) = _committee.getCommitteeStats();
        (bool inCommittee, , bool certified) = _committee.getMemberInfo(guardian);
        _updateGuardianFeesAndBootstrap(guardian, inCommittee, certified, generalCommitteeSize, certifiedCommitteeSize);

        uint48 amount = committeeBalances[guardian].feeBalance;
        committeeBalances[guardian].feeBalance = 0;
        emit FeesWithdrawn(guardian, toUint256Granularity(amount));
        require(transfer(erc20, guardian, amount), "Rewards::claimExternalTokenRewards - insufficient funds");
    }

    function migrateStakingRewardsBalance(address guardian) external override {
        require(!settings.active, "Reward distribution must be deactivated for migration");

        IRewards currentRewardsContract = IRewards(getRewardsContract());
        require(address(currentRewardsContract) != address(this), "New rewards contract is not set");

        updateDelegatorStakingRewards(guardian);

        uint48 balance = stakingRewardsBalances[guardian].balance;
        stakingRewardsBalances[guardian].balance = 0;

        require(approve(erc20, address(currentRewardsContract), balance), "migrateStakingBalance: approve failed");
        currentRewardsContract.acceptStakingRewardsMigration(guardian, toUint256Granularity(balance));

        emit StakingRewardsBalanceMigrated(guardian, toUint256Granularity(balance), address(currentRewardsContract));
    }

    function acceptStakingRewardsMigration(address guardian, uint256 amount) external override {
        uint48 amount48 = toUint48Granularity(amount);
        require(transferFrom(erc20, msg.sender, address(this), amount48), "acceptStakingMigration: transfer failed");

        uint48 balance = stakingRewardsBalances[guardian].balance.add(amount48);
        stakingRewardsBalances[guardian].balance = balance;

        emit StakingRewardsMigrationAccepted(msg.sender, guardian, amount);
    }

    function emergencyWithdraw() external override onlyMigrationManager {
        emit EmergencyWithdrawal(msg.sender);
        require(erc20.transfer(msg.sender, erc20.balanceOf(address(this))), "Rewards::emergencyWithdraw - transfer failed (fee token)");
        require(bootstrapToken.transfer(msg.sender, bootstrapToken.balanceOf(address(this))), "Rewards::emergencyWithdraw - transfer failed (bootstrap token)");
    }

    function activate(uint startTime) external override onlyMigrationManager {
        committeeTotalsPerMember.lastAssigned = uint32(startTime);
        stakingRewardsTotals.lastAssigned = uint32(startTime);
        settings.active = true;

        emit RewardDistributionActivated(startTime);
    }

    function deactivate() external override onlyMigrationManager {
        (uint generalCommitteeSize, uint certifiedCommitteeSize, uint totalStake) = committeeContract.getCommitteeStats();
        updateStakingRewardsTotals(totalStake);
        updateCommitteeTotalsPerMember(generalCommitteeSize, certifiedCommitteeSize);

        settings.active = false;

        emit RewardDistributionDeactivated();
    }

    function getSettings() external override view returns (
        uint generalCommitteeAnnualBootstrap,
        uint certifiedCommitteeAnnualBootstrap,
        uint annualStakingRewardsCap,
        uint32 annualStakingRewardsRatePercentMille,
        uint32 maxDelegatorsStakingRewardsPercentMille,
        bool active
    ) {
        Settings memory _settings = settings;
        generalCommitteeAnnualBootstrap = toUint256Granularity(_settings.generalCommitteeAnnualBootstrap);
        certifiedCommitteeAnnualBootstrap = toUint256Granularity(_settings.certifiedCommitteeAnnualBootstrap);
        annualStakingRewardsCap = toUint256Granularity(_settings.annualCap);
        annualStakingRewardsRatePercentMille = _settings.annualRateInPercentMille;
        maxDelegatorsStakingRewardsPercentMille = _settings.maxDelegatorsStakingRewardsPercentMille;
        active = _settings.active;
    }

    /*
     * Contracts topology / registry interface
     */

    ICommittee committeeContract;
    IDelegations delegationsContract;
    IGuardiansRegistration guardianRegistrationContract;
    IStakingContract stakingContract;
    IFeesWallet generalFeesWallet;
    IFeesWallet certifiedFeesWallet;
    IProtocolWallet stakingRewardsWallet;
    IProtocolWallet bootstrapRewardsWallet;
    function refreshContracts() external override {
        committeeContract = ICommittee(getCommitteeContract());
        delegationsContract = IDelegations(getDelegationsContract());
        guardianRegistrationContract = IGuardiansRegistration(getGuardiansRegistrationContract());
        stakingContract = IStakingContract(getStakingContract());
        generalFeesWallet = IFeesWallet(getGeneralFeesWallet());
        certifiedFeesWallet = IFeesWallet(getCertifiedFeesWallet());
        stakingRewardsWallet = IProtocolWallet(getStakingRewardsWallet());
        bootstrapRewardsWallet = IProtocolWallet(getBootstrapRewardsWallet());
    }
}

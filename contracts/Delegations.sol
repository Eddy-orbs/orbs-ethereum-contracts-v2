// SPDX-License-Identifier: UNLICENSED

pragma solidity 0.6.12;

import "@openzeppelin/contracts/math/SafeMath.sol";
import "@openzeppelin/contracts/math/Math.sol";

import "./spec_interfaces/IElections.sol";
import "./spec_interfaces/IGuardiansRegistration.sol";
import "./spec_interfaces/ICommittee.sol";
import "./spec_interfaces/ICertification.sol";
import "./spec_interfaces/IDelegation.sol";
import "./IStakingContract.sol";
import "./ContractRegistryAccessor.sol";
import "./IStakeChangeNotifier.sol";
import "./Lockable.sol";
import "./spec_interfaces/IStakingContractHandler.sol";
import "./ManagedContract.sol";
import "./spec_interfaces/IStakingRewards.sol";

contract Delegations is IDelegations, IStakeChangeNotifier, ManagedContract {
	using SafeMath for uint256;
	using SafeMath for uint96;

	// TODO consider using structs instead of multiple mappings
	struct StakeOwnerData {
		address delegation;
		uint96 stake;
	}
	mapping(address => StakeOwnerData) public stakeOwnersData;
	mapping(address => uint256) public uncappedStakes;

	uint256 totalDelegatedStake;

	address constant public VOID_ADDR = address(-1);

	modifier onlyStakingContractHandler() {
		require(msg.sender == address(stakingContractHandler), "caller is not the staking contract handler");

		_;
	}

	constructor(IContractRegistry _contractRegistry, address _registryAdmin) ManagedContract(_contractRegistry, _registryAdmin) public {
		address VOID_ADDRESS_DUMMY_DELEGATION = address(-2);
		assert(VOID_ADDR != VOID_ADDRESS_DUMMY_DELEGATION && VOID_ADDR != address(0) && VOID_ADDRESS_DUMMY_DELEGATION != address(0));
		stakeOwnersData[VOID_ADDR].delegation = VOID_ADDRESS_DUMMY_DELEGATION;
	}

	function getTotalDelegatedStake() external override view returns (uint256) {
		return totalDelegatedStake;
	}

	struct DelegateStatus {
		address addr;
		uint256 uncappedStakes;
		bool isSelfDelegating;
		uint256 delegatedStake;
		uint96 selfDelegatedStake;
	}

	function getDelegateStatus(address addr) private view returns (DelegateStatus memory status) {
		StakeOwnerData memory data = getStakeOwnerData(addr);

		status.addr = addr;
		status.uncappedStakes = uncappedStakes[addr];
		status.isSelfDelegating = data.delegation == addr;
		status.selfDelegatedStake = status.isSelfDelegating ? data.stake : 0;
		status.delegatedStake = status.isSelfDelegating ? status.uncappedStakes : 0;

		return status;
	}

	struct DelegateFromVars {
		DelegateStatus prevDelegateStatusBefore;
		DelegateStatus newDelegateStatusBefore;
		DelegateStatus prevDelegateStatusAfter;
		DelegateStatus newDelegateStatusAfter;
	}

	function delegateFrom(address from, address to, bool refreshStakeNotification) private {
		require(to != address(0), "cannot delegate to a zero address");

		DelegateFromVars memory vars;

		StakeOwnerData memory delegatorData = getStakeOwnerData(from);
		address prevDelegate = delegatorData.delegation;

		vars.prevDelegateStatusBefore = getDelegateStatus(prevDelegate);
		vars.newDelegateStatusBefore = getDelegateStatus(to);

		stakingRewardsContract.delegationWillChange(prevDelegate, vars.prevDelegateStatusBefore.delegatedStake, from, delegatorData.stake, to, vars.newDelegateStatusBefore.delegatedStake);

		stakeOwnersData[from].delegation = to;

		uint256 delegatorStake = delegatorData.stake;

		uncappedStakes[prevDelegate] = vars.prevDelegateStatusBefore.uncappedStakes.sub(delegatorStake);
		uncappedStakes[to] = vars.newDelegateStatusBefore.uncappedStakes.add(delegatorStake);

		vars.prevDelegateStatusAfter = getDelegateStatus(prevDelegate);
		vars.newDelegateStatusAfter = getDelegateStatus(to);

		uint256 _totalDelegatedStake = totalDelegatedStake.sub(
			vars.prevDelegateStatusBefore.delegatedStake
		).add(
			vars.prevDelegateStatusAfter.delegatedStake
		).sub(
			vars.newDelegateStatusBefore.delegatedStake
		).add(
			vars.newDelegateStatusAfter.delegatedStake
		);

		totalDelegatedStake = _totalDelegatedStake;

		if (refreshStakeNotification) {
			IElections _electionsContract = electionsContract;

			_electionsContract.delegatedStakeChange(
				prevDelegate,
				vars.prevDelegateStatusAfter.selfDelegatedStake,
				vars.prevDelegateStatusAfter.delegatedStake,
				_totalDelegatedStake
			);

			_electionsContract.delegatedStakeChange(
				to,
			    vars.newDelegateStatusAfter.selfDelegatedStake,
				vars.newDelegateStatusAfter.delegatedStake,
				_totalDelegatedStake
			);
		}

		emit Delegated(from, to);

		if (delegatorStake != 0 && prevDelegate != to) {
			emitDelegatedStakeChanged(prevDelegate, from, 0, vars.prevDelegateStatusAfter.selfDelegatedStake, vars.prevDelegateStatusAfter.delegatedStake);
			emitDelegatedStakeChanged(to, from, delegatorStake, vars.newDelegateStatusAfter.selfDelegatedStake, vars.newDelegateStatusAfter.delegatedStake);
		}
	}

	function delegate(address to) external override onlyWhenActive {
		delegateFrom(msg.sender, to, true);
	}

	bool public delegationImportFinalized;

	modifier onlyDuringDelegationImport {
		require(!delegationImportFinalized, "delegation import was finalized");

		_;
	}

	function importDelegations(address[] calldata from, address to, bool refreshStakeNotification) external override onlyMigrationManager onlyDuringDelegationImport {
		require(to != address(0), "to must be a non zero address");
		require(from.length > 0, "from array must contain at least one address");

		uint256 uncappedStakesDelta = 0;
		StakeOwnerData memory data;
		uint256 newTotalDelegatedStake = totalDelegatedStake;
		uint256[] memory delegatorsStakes = new uint256[](from.length);
		for (uint i = 0; i < from.length; i++) {

			data = stakeOwnersData[from[i]];
			require(data.delegation == address(0), "import allowed only for uninitialized accounts. existing delegation detected");
			require(data.stake == 0 , "import allowed only for uninitialized accounts. existing stake detected");

			if (to != from[i]) { // from[i] stops being self delegating. any uncappedStakes it has now stops being counted towards totalDelegatedStake
				newTotalDelegatedStake = newTotalDelegatedStake.sub(uncappedStakes[from[i]]);
			}

			// update state
			data.delegation = to;
			data.stake = uint96(stakingContractHandler.getStakeBalanceOf(from[i]));
			stakeOwnersData[from[i]] = data;

			uncappedStakesDelta = uncappedStakesDelta.add(data.stake);

			// store individual stake for event
			delegatorsStakes[i] = data.stake;
		}

		// update totals
		uncappedStakes[to] = uncappedStakes[to].add(uncappedStakesDelta);

		DelegateStatus memory delegateStatus = getDelegateStatus(to);
		if (delegateStatus.isSelfDelegating) {
			newTotalDelegatedStake = newTotalDelegatedStake.add(uncappedStakesDelta);
		}
		totalDelegatedStake = newTotalDelegatedStake;

		// emit events
		emit DelegationsImported(from, to, refreshStakeNotification);

		for (uint i = 0; i < from.length; i++) {
			emit Delegated(from[i], to);
		}

		emit DelegatedStakeChanged(
			to,
			delegateStatus.selfDelegatedStake,
			delegateStatus.delegatedStake,
			from,
			delegatorsStakes
		);

		electionsContract.delegatedStakeChange(
			to,
			delegateStatus.selfDelegatedStake,
			delegateStatus.delegatedStake,
			newTotalDelegatedStake
		);
	}

	function finalizeDelegationImport() external override onlyMigrationManager onlyDuringDelegationImport {
		delegationImportFinalized = true;
		emit DelegationImportFinalized();
	}

	function refreshStakeNotification(address addr) external override onlyWhenActive {
		StakeOwnerData memory stakeOwnerData = getStakeOwnerData(addr);
		DelegateStatus memory delegateStatus = getDelegateStatus(stakeOwnerData.delegation);
		electionsContract.delegatedStakeChange(
			stakeOwnerData.delegation,
			delegateStatus.selfDelegatedStake,
			delegateStatus.delegatedStake,
			totalDelegatedStake
		);
	}

	function refreshStake(address addr) external override onlyWhenActive {
		_stakeChange(addr, stakingContractHandler.getStakeBalanceOf(addr));
	}

	function stakeChange(address _stakeOwner, uint256, bool, uint256 _updatedStake) external override onlyStakingContractHandler onlyWhenActive {
		_stakeChange(_stakeOwner, _updatedStake);
	}

	function emitDelegatedStakeChanged(address _delegate, address delegator, uint256 delegatorStake, uint256 delegateSelfDelegatedStake, uint256 delegateTotalDelegatedStake) private {
		address[] memory delegators = new address[](1);
		uint256[] memory delegatorTotalStakes = new uint256[](1);

		delegators[0] = delegator;
		delegatorTotalStakes[0] = delegatorStake;

		emit DelegatedStakeChanged(
			_delegate,
			delegateSelfDelegatedStake,
			delegateTotalDelegatedStake,
			delegators,
			delegatorTotalStakes
		);
	}

	function emitDelegatedStakeChangedSlice(address commonDelegate, address[] memory delegators, uint256[] memory delegatorsStakes, uint startIdx, uint sliceLen) private {
		address[] memory delegatorsSlice = new address[](sliceLen);
		uint256[] memory delegatorTotalStakesSlice = new uint256[](sliceLen);

		for (uint j = 0; j < sliceLen; j++) {
			delegatorsSlice[j] = delegators[j + startIdx];
			delegatorTotalStakesSlice[j] = delegatorsStakes[j + startIdx];
		}

		DelegateStatus memory delegateStatus = getDelegateStatus(commonDelegate);

		emit DelegatedStakeChanged(
			commonDelegate,
			delegateStatus.selfDelegatedStake,
			delegateStatus.delegatedStake,
			delegatorsSlice,
			delegatorTotalStakesSlice
		);
	}

	// TODO add tests to equivalence of batched and non batched notifications
	function stakeChangeBatch(address[] calldata _stakeOwners, uint256[] calldata _amounts, bool[] calldata _signs, uint256[] calldata _updatedStakes) external override onlyStakingContractHandler onlyWhenActive {
		uint batchLength = _stakeOwners.length;
		require(batchLength == _amounts.length, "_stakeOwners, _amounts - array length mismatch");
		require(batchLength == _signs.length, "_stakeOwners, _signs - array length mismatch");
		require(batchLength == _updatedStakes.length, "_stakeOwners, _updatedStakes - array length mismatch");

		_processStakeChangeBatch(_stakeOwners, _updatedStakes);
	}

	function getDelegation(address addr) public override view returns (address) {
		return getStakeOwnerData(addr).delegation;
	}

	function getDelegationInfo(address addr) external override view returns (address delegation, uint256 delegatorStake) {
		StakeOwnerData memory data = getStakeOwnerData(addr);
		return (data.delegation, data.stake);
	}

	function getStakeOwnerData(address addr) private view returns (StakeOwnerData memory data) {
		data = stakeOwnersData[addr];
		data.delegation = (data.delegation == address(0)) ? addr : data.delegation;
		return data;
	}

	function stakeMigration(address _stakeOwner, uint256 _amount) external override onlyStakingContractHandler onlyWhenActive {}

	function _processStakeChangeBatch(address[] memory stakeOwners, uint256[] memory updatedStakes) private {
		// TODO remove dead code after gas testing
//		uint i = 0;
//		while (i < stakeOwners.length) {
//			// init sequence
//			StakeOwnerData memory curStakeOwnerData = getStakeOwnerData(stakeOwners[i]);
//			address sequenceDelegate = curStakeOwnerData.delegation;
//			uint currentUncappedStake = uncappedStakes[sequenceDelegate];
//			uint prevUncappedStake = currentUncappedStake;
//
//			uint sequenceStartIdx = i;
//			for (i = sequenceStartIdx; i < stakeOwners.length; i++) { // aggregate sequence stakes changes
//				if (i != sequenceStartIdx) curStakeOwnerData = getStakeOwnerData(stakeOwners[i]);
//				if (sequenceDelegate != curStakeOwnerData.delegation) break;
//
//				rewardsContract.delegationWillChange(sequenceDelegate, currentUncappedStake, stakeOwners[i], curStakeOwnerData.stake, sequenceDelegate);
//
//				currentUncappedStake = currentUncappedStake
//				.sub(curStakeOwnerData.stake)
//				.add(updatedStakes[i]);
//
//				require(uint256(uint96(updatedStakes[i])) == updatedStakes[i], "Delegations::updatedStakes value too big (>96 bits)");
//				stakeOwnersData[stakeOwners[i]].stake = uint96(updatedStakes[i]);
//			}
//
//			// closing sequence
//			uncappedStakes[sequenceDelegate] = currentUncappedStake;
//			if (_isSelfDelegating(sequenceDelegate)) {
//				totalDelegatedStake = totalDelegatedStake.sub(prevUncappedStake).add(currentUncappedStake);
//			}
//
//			emitDelegatedStakeChangedSlice(sequenceDelegate, stakeOwners, updatedStakes, sequenceStartIdx, i - sequenceStartIdx);
//		}
		for (uint i = 0; i < stakeOwners.length; i++) {
			_stakeChange(stakeOwners[i], updatedStakes[i]);
		}
	}

	function _stakeChange(address _stakeOwner, uint256 _updatedStake) private {
		StakeOwnerData memory stakeOwnerDataBefore = getStakeOwnerData(_stakeOwner);
		DelegateStatus memory delegateStatusBefore = getDelegateStatus(stakeOwnerDataBefore.delegation);

		uint256 prevUncappedStake = delegateStatusBefore.uncappedStakes;
		uint256 newUncappedStake = prevUncappedStake.sub(stakeOwnerDataBefore.stake).add(_updatedStake);

		stakingRewardsContract.delegationWillChange(stakeOwnerDataBefore.delegation, delegateStatusBefore.delegatedStake, _stakeOwner, stakeOwnerDataBefore.stake, stakeOwnerDataBefore.delegation, delegateStatusBefore.delegatedStake);

		uncappedStakes[stakeOwnerDataBefore.delegation] = newUncappedStake;

		require(uint256(uint96(_updatedStake)) == _updatedStake, "Delegations::updatedStakes value too big (>96 bits)");
		stakeOwnersData[_stakeOwner].stake = uint96(_updatedStake);

		uint256 _totalDelegatedStake = totalDelegatedStake;
		if (delegateStatusBefore.isSelfDelegating) {
			_totalDelegatedStake = _totalDelegatedStake.sub(stakeOwnerDataBefore.stake).add(_updatedStake);
			totalDelegatedStake = _totalDelegatedStake;
		}

		DelegateStatus memory delegateStatusAfter = getDelegateStatus(stakeOwnerDataBefore.delegation);

		electionsContract.delegatedStakeChange(
			stakeOwnerDataBefore.delegation,
			delegateStatusAfter.selfDelegatedStake,
			delegateStatusAfter.delegatedStake,
			_totalDelegatedStake
		);

		if (_updatedStake != stakeOwnerDataBefore.stake) {
			emitDelegatedStakeChanged(stakeOwnerDataBefore.delegation, _stakeOwner, _updatedStake, delegateStatusAfter.selfDelegatedStake, delegateStatusAfter.delegatedStake);
		}
	}

	function getDelegatedStake(address addr) external override view returns (uint256) {
		return _isSelfDelegating(addr) ? uncappedStakes[addr] : 0;
	}

	function _isSelfDelegating(address addr) private view returns (bool) {
		return getDelegation(addr) == addr;
	}

	IElections electionsContract;
	IStakingRewards stakingRewardsContract;
	IStakingContractHandler stakingContractHandler;
	function refreshContracts() external override {
		electionsContract = IElections(getElectionsContract());
		stakingContractHandler = IStakingContractHandler(getStakingContractHandler());
		stakingRewardsContract = IStakingRewards(getStakingRewardsContract());
	}

}

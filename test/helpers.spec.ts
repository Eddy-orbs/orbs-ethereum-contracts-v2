import chai from "chai";
const expect = chai.expect;

import {getAbiByContractAddress, getAbiByContractName, getAbiByContractRegistryKey} from "../abi-loader";
import {loadCompiledContracts} from "../compiled-contracts";
import {deployedContracts} from "../deployed-contracts";

describe("helpers tests", async () => {

    const compiledContracts = loadCompiledContracts();

    it("should return the ABI by the registry key name", async () => {
        expect(getAbiByContractRegistryKey('protocol')).to.deep.eq(compiledContracts.Protocol.abi);
        expect(getAbiByContractRegistryKey('committee')).to.deep.eq(compiledContracts.Committee.abi);
        expect(getAbiByContractRegistryKey('elections')).to.deep.eq(compiledContracts.Elections.abi);
        expect(getAbiByContractRegistryKey('delegations')).to.deep.eq(compiledContracts.Delegations.abi);
        expect(getAbiByContractRegistryKey('guardiansRegistration')).to.deep.eq(compiledContracts.GuardiansRegistration.abi);
        expect(getAbiByContractRegistryKey('certification')).to.deep.eq(compiledContracts.Certification.abi);
        expect(getAbiByContractRegistryKey('staking')).to.deep.eq(compiledContracts.StakingContract.abi);
        expect(getAbiByContractRegistryKey('subscriptions')).to.deep.eq(compiledContracts.Subscriptions.abi);
        expect(getAbiByContractRegistryKey('stakingRewards')).to.deep.eq(compiledContracts.StakingRewards.abi);
        expect(getAbiByContractRegistryKey('feesAndBootstrapRewards')).to.deep.eq(compiledContracts.FeesAndBootstrapRewards.abi);
        expect(getAbiByContractRegistryKey('stakingRewardsWallet')).to.deep.eq(compiledContracts.ProtocolWallet.abi);
        expect(getAbiByContractRegistryKey('bootstrapRewardsWallet')).to.deep.eq(compiledContracts.ProtocolWallet.abi);
        expect(getAbiByContractRegistryKey('generalFeesWallet')).to.deep.eq(compiledContracts.FeesWallet.abi);
        expect(getAbiByContractRegistryKey('certifiedFeesWallet')).to.deep.eq(compiledContracts.FeesWallet.abi);
        expect(getAbiByContractRegistryKey('stakingContractHandler')).to.deep.eq(compiledContracts.StakingContractHandler.abi);
        expect(() => getAbiByContractRegistryKey('nonExistentKey' as string as any)).to.throw(`No such contract registry key: nonExistentKey`);
    });

    it("should return the ABI by the contract name", async () => {
        expect(getAbiByContractName('Protocol')).to.deep.eq(compiledContracts.Protocol.abi);
        expect(getAbiByContractName('Committee')).to.deep.eq(compiledContracts.Committee.abi);
        expect(getAbiByContractName('Elections')).to.deep.eq(compiledContracts.Elections.abi);
        expect(getAbiByContractName('Delegations')).to.deep.eq(compiledContracts.Delegations.abi);
        expect(getAbiByContractName('GuardiansRegistration')).to.deep.eq(compiledContracts.GuardiansRegistration.abi);
        expect(getAbiByContractName('Certification')).to.deep.eq(compiledContracts.Certification.abi);
        expect(getAbiByContractName('StakingContract')).to.deep.eq(compiledContracts.StakingContract.abi);
        expect(getAbiByContractName('Subscriptions')).to.deep.eq(compiledContracts.Subscriptions.abi);
        expect(getAbiByContractName('StakingRewards')).to.deep.eq(compiledContracts.StakingRewards.abi);
        expect(getAbiByContractName('FeesAndBootstrapRewards')).to.deep.eq(compiledContracts.FeesAndBootstrapRewards.abi);
        expect(getAbiByContractName('ProtocolWallet')).to.deep.eq(compiledContracts.ProtocolWallet.abi);
        expect(getAbiByContractName('FeesWallet')).to.deep.eq(compiledContracts.FeesWallet.abi);
        expect(getAbiByContractName('StakingContractHandler')).to.deep.eq(compiledContracts.StakingContractHandler.abi);
        expect(() => getAbiByContractName('nonExistentName' as string as any)).to.throw()
    });

    it("should return the ABI by address", async () => {
        expect(getAbiByContractAddress("0xAB7F3d56Da621Cff1F5646642d7F79f6A201E4eD")).to.deep.eq(deployedContracts["0xAB7F3d56Da621Cff1F5646642d7F79f6A201E4eD"]);
        expect(getAbiByContractAddress("0xAB7F3d56Da621Cff1F5646642d7F79f6A201E4ed")).to.deep.eq(deployedContracts["0xAB7F3d56Da621Cff1F5646642d7F79f6A201E4eD"]);
        expect(getAbiByContractAddress("0x10E441aA45A7fb4230d1370Fba3CF98269bd4b5D")).to.deep.eq(deployedContracts["0x10E441aA45A7fb4230d1370Fba3CF98269bd4b5D"]);
        expect(getAbiByContractAddress("0x10E441aA45A7fb4230d1370Fba3CF98269bd4b5d")).to.deep.eq(deployedContracts["0x10E441aA45A7fb4230d1370Fba3CF98269bd4b5D"]);
        expect(getAbiByContractAddress("0x1234567890123456789012345678901234567890")).to.be.undefined;
    });

});
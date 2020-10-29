import 'mocha';
import Web3 from "web3";
import BN from "bn.js";
import * as _ from "lodash";
import {
    defaultDriverOptions,
    Driver,
    Participant, ZERO_ADDR
} from "./driver";
import chai from "chai";
import {createVC} from "./consumer-macros";
import {
    bn,
    bnSum,
    evmIncreaseTime,
    evmIncreaseTimeForQueries,
    expectRejected,
    fromMilliOrbs,
    toMilliOrbs
} from "./helpers";
import {
    stakingRewardsAssignedEvents, stakingRewardsClaimedEvents,
} from "./event-parsing";
import {chaiEventMatchersPlugin} from "./matchers";
import {StakingRewardsClaimedEvent} from "../typings/staking-rewards-contract";
import {TransactionReceipt} from "web3-core";

declare const web3: Web3;

chai.use(require('chai-bn')(BN));
chai.use(chaiEventMatchersPlugin);

const expect = chai.expect;
const assert = chai.assert;

const BASE_STAKE = fromMilliOrbs(1000);
const MONTH_IN_SECONDS = 30*24*60*60;
const MAX_COMMITTEE = 4;

const GENERAL_FEES_MONTHLY_RATE = fromMilliOrbs(1000);
const CERTIFIED_FEES_MONTHLY_RATE = fromMilliOrbs(2000);

const GENERAL_ANNUAL_BOOTSTRAP = fromMilliOrbs(12000);
const CERTIFIED_ANNUAL_BOOTSTRAP = fromMilliOrbs(15000);

const STAKING_REWARDS_ANNUAL_RATE = bn(12000);
const STAKING_REWARDS_ANNUAL_CAP = fromMilliOrbs(10000)

const MIN_SELF_STAKE_PERCENT_MILLE = bn(13000);

const DELEGATOR_REWARDS_PERCENT_MILLE = bn(67000);

const YEAR_IN_SECONDS = 365*24*60*60;

async function fullCommittee(stakes?: BN[] | null, numVCs=2, opts?: {
    stakingRewardsAnnualRate?: BN,
    stakingRewardsAnnualCap?: BN,
    minSelfStakePercentMille?: BN
}): Promise<{d: Driver, committee: Participant[]}> {
    opts = opts || {};

    const stakingRewardsAnnualRate: BN = opts.stakingRewardsAnnualRate || STAKING_REWARDS_ANNUAL_RATE;
    const stakingRewardsAnnualCap: BN = opts.stakingRewardsAnnualCap || STAKING_REWARDS_ANNUAL_CAP;
    const minSelfStakePercentMille: BN = opts.minSelfStakePercentMille || MIN_SELF_STAKE_PERCENT_MILLE;

    const d = await Driver.new({maxCommitteeSize: MAX_COMMITTEE, minSelfStakePercentMille: minSelfStakePercentMille.toNumber(), defaultDelegatorsStakingRewardsPercentMille: DELEGATOR_REWARDS_PERCENT_MILLE});

    const g = d.newParticipant();
    const poolAmount = fromMilliOrbs(1000000000000);
    await g.assignAndApproveOrbs(poolAmount, d.stakingRewardsWallet.address);
    await d.stakingRewardsWallet.topUp(poolAmount, {from: g.address});
    let r = await d.stakingRewards.setAnnualStakingRewardsRate(stakingRewardsAnnualRate, stakingRewardsAnnualCap, {from: d.functionalManager.address});
    expect(r).to.have.a.annualStakingRewardsRateChangedEvent({
        annualRateInPercentMille: stakingRewardsAnnualRate,
        annualCap: stakingRewardsAnnualCap
    })

    await g.assignAndApproveExternalToken(poolAmount, d.bootstrapRewardsWallet.address);
    await d.bootstrapRewardsWallet.topUp(poolAmount, {from: g.address});
    await d.feesAndBootstrapRewards.setGeneralCommitteeAnnualBootstrap(GENERAL_ANNUAL_BOOTSTRAP, {from: d.functionalManager.address});
    await d.feesAndBootstrapRewards.setCertifiedCommitteeAnnualBootstrap(CERTIFIED_ANNUAL_BOOTSTRAP, {from: d.functionalManager.address});

    let committee: Participant[] = [];
    for (let i = 0; i < MAX_COMMITTEE; i++) {
        const stake = stakes ? stakes[i] : BASE_STAKE;
        const {v} = await d.newGuardian(stake, false, false, false);
        committee.push(v);
    }

    await Promise.all(_.shuffle(committee).map(v => v.readyForCommittee()));

    const subsGeneral = await d.newSubscriber('defaultTier', GENERAL_FEES_MONTHLY_RATE);
    const subsCertified = await d.newSubscriber('defaultTier', CERTIFIED_FEES_MONTHLY_RATE);
    const appOwner = d.newParticipant();

    for (let i = 0; i < numVCs; i++) {
        await createVC(d, false, subsGeneral, GENERAL_FEES_MONTHLY_RATE, appOwner);
        await createVC(d, true, subsCertified, CERTIFIED_FEES_MONTHLY_RATE, appOwner);
    }

    return {
        d,
        committee,
    }
}

function rewardsForDuration(duration: number, nMembers: number, monthlyRate: BN): BN {
    return bn(duration).mul(monthlyRate).div(bn(MONTH_IN_SECONDS)).div(bn(nMembers));
}

function generalFeesForDuration(duration: number, nMembers: number): BN {
    return rewardsForDuration(duration, nMembers, GENERAL_FEES_MONTHLY_RATE);
}

function certifiedFeesForDuration(duration: number, nMembersCertified: number, nMembersGeneral): BN {
    return rewardsForDuration(duration, nMembersCertified, CERTIFIED_FEES_MONTHLY_RATE).add(rewardsForDuration(duration, nMembersGeneral, GENERAL_FEES_MONTHLY_RATE));
}

function generalBootstrapForDuration(duration: number): BN {
    return rewardsForDuration(duration, 1, GENERAL_ANNUAL_BOOTSTRAP.div(bn(12)));
}

function certifiedBootstrapForDuration(duration: number): BN {
    return rewardsForDuration(duration, 1, CERTIFIED_ANNUAL_BOOTSTRAP.add(GENERAL_ANNUAL_BOOTSTRAP).div(bn(12)));
}

function roundToMilliOrbs(x: BN): BN {
    return fromMilliOrbs(toMilliOrbs(x));
}

async function stakingRewardsForDuration(d: Driver, duration: number, delegator: Participant, guardian: Participant): Promise<{delegatorRewards: BN, guardianRewards: BN}> {
    const memberInfo = await d.committee.getMemberInfo(guardian.address);
    const guardianWeight = bn(memberInfo.weight);
    const totalWeight = bn(memberInfo.totalCommitteeWeight)

    const settings = await d.stakingRewards.getSettings();
    const cap = bn(settings.annualStakingRewardsCap);
    const rate = bn(settings.annualStakingRewardsRatePercentMille);
    const ratio = bn(await d.stakingRewards.getGuardianDelegatorsStakingRewardsPercentMille(guardian.address));

    const actualRate = BN.min(totalWeight.mul(rate).div(bn(100000)), cap).mul(bn(100000)).div(totalWeight);

    const delegatorStake = bn((await d.delegations.getDelegationInfo(delegator.address)).delegatorStake);
    const guardianStake = bn((await d.delegations.getDelegationInfo(guardian.address)).delegatorStake);
    const guardianDelegatedStake = bn(await d.delegations.getDelegatedStake(guardian.address));

    const totalRewards = guardianWeight.mul(actualRate).mul(bn(duration)).div(bn(YEAR_IN_SECONDS * 100000));
    const totalDelegatorRewards = totalRewards.mul(ratio).div(bn(100000));
    let guardianRewards = totalRewards.mul(bn(100000).sub(ratio)).div(bn(100000));
    const delegatorRewards = totalDelegatorRewards.mul(delegatorStake).div(guardianDelegatedStake);
    guardianRewards = guardianRewards.add(totalDelegatorRewards.mul(guardianStake).div(guardianDelegatedStake))

    return {
        delegatorRewards,
        guardianRewards,
    }
}

function expectApproxEq(actual: BN|string|number, expected: BN|string|number) {
    actual = roundToMilliOrbs(bn(actual));
    expected = roundToMilliOrbs(bn(expected));
    assert(bn(actual).sub(bn(expected)).abs().lte(BN.max(bn(actual), bn(expected)).div(bn(50))), `Expected ${actual.toString()} to approx. equal ${expected.toString()}`);
}

function getTotalClaimedFromEvent(r: TransactionReceipt): BN {
    const event: StakingRewardsClaimedEvent = stakingRewardsClaimedEvents(r)[0];
    return bn(event.claimedDelegatorRewards).add(bn(event.claimedGuardianRewards));
}

async function totalStakingRewardsBalance(d: Driver, p: Participant): Promise<BN> {
    const balances = await d.stakingRewards.getStakingRewardsBalance(p.address);
    return bn(balances.delegatorStakingRewardsBalance).add(bn(balances.guardianStakingRewardsBalance));
}

describe('rewards', async () => {

    // Bootstrap and fees

    it('assigned bootstrap rewards and fees according to committee member participation (general committee), emits events', async () => {
        const {d, committee} = await fullCommittee(null, 1);

        const DURATION = MONTH_IN_SECONDS * 5;

        // First committee member comes and goes, in committee for DURATION / 2 seconds in total
        // Second committee member is present the entire time

        let c0Fees = await committee[0].getFeeBalance()
        let c0Bootstrap = await committee[0].getBootstrapBalance()
        let c1Fees = await committee[1].getFeeBalance()
        let c1Bootstrap = await committee[1].getBootstrapBalance()

        expectApproxEq(c0Fees, 0);
        expectApproxEq(c0Bootstrap, 0);

        expectApproxEq(c1Fees, 0);
        expectApproxEq(c1Bootstrap, 0);

        await evmIncreaseTimeForQueries(d.web3, DURATION / 4);

        expectApproxEq(await committee[0].getFeeBalance(), generalFeesForDuration(DURATION / 4, MAX_COMMITTEE));
        expectApproxEq(await committee[0].getBootstrapBalance(), generalBootstrapForDuration(DURATION / 4));

        expectApproxEq(await committee[1].getFeeBalance(), generalFeesForDuration(DURATION / 4, MAX_COMMITTEE));
        expectApproxEq(await committee[1].getBootstrapBalance(), generalBootstrapForDuration(DURATION / 4));

        let r = await committee[0].readyToSync(); // leaves committee
        expect(r).to.have.a.approx().feesAllocatedEvent({
            allocatedGeneralFees: bn(await committee[0].getFeeBalance()).mul(bn(MAX_COMMITTEE)),
            generalFeesPerMember: bn(await committee[0].getFeeBalance()),
            allocatedCertifiedFees: certifiedFeesForDuration(DURATION / 4, MAX_COMMITTEE, MAX_COMMITTEE).sub(generalFeesForDuration(DURATION / 4, MAX_COMMITTEE)).mul(bn(MAX_COMMITTEE)),
            certifiedFeesPerMember: bn(0)
        });
        expect(r).to.have.a.approx().bootstrapRewardsAllocatedEvent({
            allocatedGeneralBootstrapRewards: bn(await committee[0].getBootstrapBalance()).mul(bn(MAX_COMMITTEE)),
            generalBootstrapRewardsPerMember: bn(await committee[0].getBootstrapBalance()),
            allocatedCertifiedBootstrapRewards: bn(0),
            certifiedBootstrapRewardsPerMember: certifiedBootstrapForDuration(DURATION / 4),
        });
        expect(r).to.have.a.approx().feesAssignedEvent({
            guardian: committee[0].address,
            amount: generalFeesForDuration(DURATION / 4, MAX_COMMITTEE),
            totalAwarded: generalFeesForDuration(DURATION / 4, MAX_COMMITTEE),
            certification: false,
            feesPerMember: generalFeesForDuration(DURATION / 4, MAX_COMMITTEE)
        });
        expect(r).to.have.a.approx().bootstrapRewardsAssignedEvent({
            guardian: committee[0].address,
            amount: generalBootstrapForDuration(DURATION / 4),
            totalAwarded: generalBootstrapForDuration(DURATION / 4),
            certification: false,
            bootstrapPerMember: generalBootstrapForDuration(DURATION / 4)
        });

        expectApproxEq(await committee[0].getFeeBalance(), generalFeesForDuration(DURATION / 4, MAX_COMMITTEE));
        expectApproxEq(await committee[0].getBootstrapBalance(), generalBootstrapForDuration(DURATION / 4));

        expectApproxEq(await committee[1].getFeeBalance(), generalFeesForDuration(DURATION / 4, MAX_COMMITTEE));
        expectApproxEq(await committee[1].getBootstrapBalance(), generalBootstrapForDuration(DURATION / 4));

        await evmIncreaseTimeForQueries(d.web3, DURATION / 4);

        expectApproxEq(await committee[0].getFeeBalance(), generalFeesForDuration(DURATION / 4, MAX_COMMITTEE));
        expectApproxEq(await committee[0].getBootstrapBalance(), generalBootstrapForDuration(DURATION / 4));

        expectApproxEq(await committee[1].getFeeBalance(), generalFeesForDuration(DURATION / 4, MAX_COMMITTEE).add(generalFeesForDuration(DURATION / 4, MAX_COMMITTEE - 1)));
        expectApproxEq(await committee[1].getBootstrapBalance(), generalBootstrapForDuration(DURATION / 2));

        r = await committee[0].readyForCommittee(); // joins committee
        expect(r).to.have.a.approx().feesAssignedEvent({guardian: committee[0].address, amount: bn(0)});
        expect(r).to.have.a.approx().bootstrapRewardsAssignedEvent({guardian: committee[0].address, amount: bn(0)});

        expectApproxEq(await committee[0].getFeeBalance(), generalFeesForDuration(DURATION / 4, MAX_COMMITTEE));
        expectApproxEq(await committee[0].getBootstrapBalance(), generalBootstrapForDuration(DURATION / 4));

        expectApproxEq(await committee[1].getFeeBalance(), generalFeesForDuration(DURATION / 4, MAX_COMMITTEE).add(generalFeesForDuration(DURATION / 4, MAX_COMMITTEE - 1)));
        expectApproxEq(await committee[1].getBootstrapBalance(), generalBootstrapForDuration(DURATION / 2));

        await evmIncreaseTimeForQueries(d.web3, DURATION / 4);

        expectApproxEq(await committee[0].getFeeBalance(), generalFeesForDuration(DURATION / 2, MAX_COMMITTEE));
        expectApproxEq(await committee[0].getBootstrapBalance(), generalBootstrapForDuration(DURATION / 2));

        expectApproxEq(await committee[1].getFeeBalance(), generalFeesForDuration(DURATION / 2, MAX_COMMITTEE).add(generalFeesForDuration(DURATION / 4, MAX_COMMITTEE - 1)));
        expectApproxEq(await committee[1].getBootstrapBalance(), generalBootstrapForDuration(DURATION / 4 * 3));

        await committee[0].readyToSync(); // leaves committee

        expectApproxEq(await committee[0].getFeeBalance(), generalFeesForDuration(DURATION / 2, MAX_COMMITTEE));
        expectApproxEq(await committee[0].getBootstrapBalance(), generalBootstrapForDuration(DURATION / 2));

        expectApproxEq(await committee[1].getFeeBalance(), generalFeesForDuration(DURATION / 2, MAX_COMMITTEE).add(generalFeesForDuration(DURATION / 4, MAX_COMMITTEE - 1)));
        expectApproxEq(await committee[1].getBootstrapBalance(), generalBootstrapForDuration(DURATION / 4 * 3));

        await evmIncreaseTimeForQueries(d.web3, DURATION / 4);

        expectApproxEq(await committee[0].getFeeBalance(), generalFeesForDuration(DURATION / 2, MAX_COMMITTEE));
        expectApproxEq(await committee[0].getBootstrapBalance(), generalBootstrapForDuration(DURATION / 2));

        expectApproxEq(await committee[1].getFeeBalance(), generalFeesForDuration(DURATION / 2, MAX_COMMITTEE).add(generalFeesForDuration(DURATION / 2, MAX_COMMITTEE - 1)));
        expectApproxEq(await committee[1].getBootstrapBalance(), generalBootstrapForDuration(DURATION));

        const c0OrbsBalance = await d.erc20.balanceOf(committee[0].address);
        r = await d.feesAndBootstrapRewards.withdrawFees(committee[0].address);
        expect(r).to.have.a.feesAssignedEvent({});
        const c0AssignedFees = bn(await d.erc20.balanceOf(committee[0].address)).sub(bn(c0OrbsBalance));
        expectApproxEq(c0AssignedFees, generalFeesForDuration(DURATION / 2, MAX_COMMITTEE))

        const c0BootstrapBalance = await d.bootstrapToken.balanceOf(committee[0].address);
        r = await d.feesAndBootstrapRewards.withdrawBootstrapFunds(committee[0].address);
        expect(r).to.have.a.bootstrapRewardsAssignedEvent({});
        const c0AssignedBootstrap = bn(await d.bootstrapToken.balanceOf(committee[0].address)).sub(bn(c0BootstrapBalance));
        expectApproxEq(c0AssignedBootstrap, generalBootstrapForDuration(DURATION / 2));

        const c1OrbsBalance = await d.erc20.balanceOf(committee[1].address);
        await d.feesAndBootstrapRewards.withdrawFees(committee[1].address);
        const c1AssignedFees = bn(await d.erc20.balanceOf(committee[1].address)).sub(bn(c1OrbsBalance));
        expectApproxEq(c1AssignedFees, generalFeesForDuration(DURATION / 2, MAX_COMMITTEE).add(generalFeesForDuration(DURATION / 2, MAX_COMMITTEE - 1)));

        const c1BootstrapBalance = await d.bootstrapToken.balanceOf(committee[1].address);
        await d.feesAndBootstrapRewards.withdrawBootstrapFunds(committee[1].address);
        const c1AssignedBootstrap = bn(await d.bootstrapToken.balanceOf(committee[1].address)).sub(bn(c1BootstrapBalance));
        expectApproxEq(c1AssignedBootstrap, generalBootstrapForDuration(DURATION));

        expect(c0AssignedFees).to.be.bignumber.gt(bn(0));
        expect(c1AssignedFees).to.be.bignumber.gt(bn(0));
        expect(c0AssignedBootstrap).to.be.bignumber.gt(bn(0));
        expect(c1AssignedBootstrap).to.be.bignumber.gt(bn(0));
    });

    it('assigned bootstrap rewards and fees according to committee member participation (compliance committee)', async () => {
        const {d, committee} = await fullCommittee(null, 1);

        await Promise.all(committee.map(c => c.becomeCertified()));

        const DURATION = MONTH_IN_SECONDS*5;

        // First committee member comes and goes, in committee for DURATION / 2 seconds in total
        // Second committee member is present the entire time

        expectApproxEq(await committee[0].getFeeBalance(), 0);
        expectApproxEq(await committee[0].getBootstrapBalance(), 0);

        expectApproxEq(await committee[1].getFeeBalance(), 0);
        expectApproxEq(await committee[1].getBootstrapBalance(), 0);

        await evmIncreaseTimeForQueries(d.web3, DURATION / 4);

        expectApproxEq(await committee[0].getFeeBalance(), certifiedFeesForDuration(DURATION / 4, MAX_COMMITTEE, MAX_COMMITTEE));
        expectApproxEq(await committee[0].getBootstrapBalance(), certifiedBootstrapForDuration(DURATION / 4));

        expectApproxEq(await committee[1].getFeeBalance(), certifiedFeesForDuration(DURATION / 4, MAX_COMMITTEE, MAX_COMMITTEE));
        expectApproxEq(await committee[1].getBootstrapBalance(), certifiedBootstrapForDuration(DURATION / 4));

        let r = await committee[0].becomeNotCertified(); // leaves certified committee
        expect(r).to.have.a.approx().feesAllocatedEvent({
            allocatedGeneralFees: generalFeesForDuration(DURATION / 4, MAX_COMMITTEE).mul(bn(MAX_COMMITTEE)),
            generalFeesPerMember: generalFeesForDuration(DURATION / 4, MAX_COMMITTEE),
            allocatedCertifiedFees: certifiedFeesForDuration(DURATION / 4, MAX_COMMITTEE, MAX_COMMITTEE).sub(generalFeesForDuration(DURATION / 4, MAX_COMMITTEE)).mul(bn(MAX_COMMITTEE)),
            certifiedFeesPerMember: certifiedFeesForDuration(DURATION / 4, MAX_COMMITTEE, MAX_COMMITTEE)
        });
        expect(r).to.have.a.approx().bootstrapRewardsAllocatedEvent({
            allocatedGeneralBootstrapRewards: generalBootstrapForDuration(DURATION / 4).mul(bn(MAX_COMMITTEE)),
            generalBootstrapRewardsPerMember: generalBootstrapForDuration(DURATION / 4),
            allocatedCertifiedBootstrapRewards: certifiedBootstrapForDuration(DURATION / 4).mul(bn(MAX_COMMITTEE)),
            certifiedBootstrapRewardsPerMember: certifiedBootstrapForDuration(DURATION / 4),
        });


        expectApproxEq(await committee[0].getFeeBalance(), certifiedFeesForDuration(DURATION / 4, MAX_COMMITTEE, MAX_COMMITTEE));
        expectApproxEq(await committee[0].getBootstrapBalance(), certifiedBootstrapForDuration(DURATION / 4));

        expectApproxEq(await committee[1].getFeeBalance(), certifiedFeesForDuration(DURATION / 4, MAX_COMMITTEE, MAX_COMMITTEE));
        expectApproxEq(await committee[1].getBootstrapBalance(), certifiedBootstrapForDuration(DURATION / 4));

        await evmIncreaseTimeForQueries(d.web3, DURATION / 4);

        expectApproxEq(await committee[0].getFeeBalance(), certifiedFeesForDuration(DURATION / 4, MAX_COMMITTEE, MAX_COMMITTEE).add(generalFeesForDuration(DURATION / 4, MAX_COMMITTEE)));
        expectApproxEq(await committee[0].getBootstrapBalance(), certifiedBootstrapForDuration(DURATION / 4).add(generalBootstrapForDuration(DURATION / 4)));

        expectApproxEq(await committee[1].getFeeBalance(), certifiedFeesForDuration(DURATION / 4, MAX_COMMITTEE, MAX_COMMITTEE).add(certifiedFeesForDuration(DURATION / 4, MAX_COMMITTEE - 1, MAX_COMMITTEE)));
        expectApproxEq(await committee[1].getBootstrapBalance(), certifiedBootstrapForDuration(DURATION / 2));

        await committee[0].becomeCertified(); // joins certified committee

        expectApproxEq(await committee[0].getFeeBalance(), certifiedFeesForDuration(DURATION / 4, MAX_COMMITTEE, MAX_COMMITTEE).add(generalFeesForDuration(DURATION / 4, MAX_COMMITTEE)));
        expectApproxEq(await committee[0].getBootstrapBalance(), certifiedBootstrapForDuration(DURATION / 4).add(generalBootstrapForDuration(DURATION / 4)));

        expectApproxEq(await committee[1].getFeeBalance(), certifiedFeesForDuration(DURATION / 4, MAX_COMMITTEE, MAX_COMMITTEE).add(certifiedFeesForDuration(DURATION / 4, MAX_COMMITTEE - 1, MAX_COMMITTEE)));
        expectApproxEq(await committee[1].getBootstrapBalance(), certifiedBootstrapForDuration(DURATION / 2));

        await evmIncreaseTimeForQueries(d.web3, DURATION / 4);

        expectApproxEq(await committee[0].getFeeBalance(), certifiedFeesForDuration(DURATION / 2, MAX_COMMITTEE, MAX_COMMITTEE).add(generalFeesForDuration(DURATION / 4, MAX_COMMITTEE)));
        expectApproxEq(await committee[0].getBootstrapBalance(), certifiedBootstrapForDuration(DURATION / 2).add(generalBootstrapForDuration(DURATION / 4)));

        expectApproxEq(await committee[1].getFeeBalance(), certifiedFeesForDuration(DURATION / 2, MAX_COMMITTEE, MAX_COMMITTEE).add(certifiedFeesForDuration(DURATION / 4, MAX_COMMITTEE - 1, MAX_COMMITTEE)));
        expectApproxEq(await committee[1].getBootstrapBalance(), certifiedBootstrapForDuration(DURATION / 4 * 3));

        await committee[0].readyToSync(); // leaves both committees

        expectApproxEq(await committee[0].getFeeBalance(), certifiedFeesForDuration(DURATION / 2, MAX_COMMITTEE, MAX_COMMITTEE).add(generalFeesForDuration(DURATION / 4, MAX_COMMITTEE)));
        expectApproxEq(await committee[0].getBootstrapBalance(), certifiedBootstrapForDuration(DURATION / 2).add(generalBootstrapForDuration(DURATION / 4)));

        expectApproxEq(await committee[1].getFeeBalance(), certifiedFeesForDuration(DURATION / 2, MAX_COMMITTEE, MAX_COMMITTEE).add(certifiedFeesForDuration(DURATION / 4, MAX_COMMITTEE - 1, MAX_COMMITTEE)));
        expectApproxEq(await committee[1].getBootstrapBalance(), certifiedBootstrapForDuration(DURATION / 4 * 3));

        await evmIncreaseTimeForQueries(d.web3, DURATION / 4);

        expectApproxEq(await committee[0].getFeeBalance(), certifiedFeesForDuration(DURATION / 2, MAX_COMMITTEE, MAX_COMMITTEE).add(generalFeesForDuration(DURATION / 4, MAX_COMMITTEE)));
        expectApproxEq(await committee[0].getBootstrapBalance(), certifiedBootstrapForDuration(DURATION / 2).add(generalBootstrapForDuration(DURATION / 4)));

        expectApproxEq(await committee[1].getFeeBalance(), certifiedFeesForDuration(DURATION / 2, MAX_COMMITTEE, MAX_COMMITTEE).add(certifiedFeesForDuration(DURATION / 4, MAX_COMMITTEE - 1, MAX_COMMITTEE)).add(certifiedFeesForDuration(DURATION / 4, MAX_COMMITTEE - 1, MAX_COMMITTEE - 1)));
        expectApproxEq(await committee[1].getBootstrapBalance(), certifiedBootstrapForDuration(DURATION));

        const c0OrbsBalance = await d.erc20.balanceOf(committee[0].address);
        await d.feesAndBootstrapRewards.withdrawFees(committee[0].address);
        const c0AssignedFees = bn(await d.erc20.balanceOf(committee[0].address)).sub(bn(c0OrbsBalance));
        expectApproxEq(c0AssignedFees, certifiedFeesForDuration(DURATION / 2, MAX_COMMITTEE, MAX_COMMITTEE).add(generalFeesForDuration(DURATION / 4, MAX_COMMITTEE)))

        const c0BootstrapBalance = await d.bootstrapToken.balanceOf(committee[0].address);
        await d.feesAndBootstrapRewards.withdrawBootstrapFunds(committee[0].address);
        const c0AssignedBootstrap = bn(await d.bootstrapToken.balanceOf(committee[0].address)).sub(bn(c0BootstrapBalance));
        expectApproxEq(c0AssignedBootstrap, certifiedBootstrapForDuration(DURATION / 2).add(generalBootstrapForDuration(DURATION / 4)));

        const c1OrbsBalance = await d.erc20.balanceOf(committee[1].address);
        await d.feesAndBootstrapRewards.withdrawFees(committee[1].address);
        const c1AssignedFees = bn(await d.erc20.balanceOf(committee[1].address)).sub(bn(c1OrbsBalance));
        expectApproxEq(c1AssignedFees, certifiedFeesForDuration(DURATION / 2, MAX_COMMITTEE, MAX_COMMITTEE).add(certifiedFeesForDuration(DURATION / 4, MAX_COMMITTEE - 1, MAX_COMMITTEE)).add(certifiedFeesForDuration(DURATION / 4, MAX_COMMITTEE - 1, MAX_COMMITTEE - 1)));

        const c1BootstrapBalance = await d.bootstrapToken.balanceOf(committee[1].address);
        await d.feesAndBootstrapRewards.withdrawBootstrapFunds(committee[1].address);
        const c1AssignedBootstrap = bn(await d.bootstrapToken.balanceOf(committee[1].address)).sub(bn(c1BootstrapBalance));
        expectApproxEq(c1AssignedBootstrap, certifiedBootstrapForDuration(DURATION));

        expect(c0AssignedFees).to.be.bignumber.gt(bn(0));
        expect(c1AssignedFees).to.be.bignumber.gt(bn(0));
        expect(c0AssignedBootstrap).to.be.bignumber.gt(bn(0));
        expect(c1AssignedBootstrap).to.be.bignumber.gt(bn(0));
    });

    it('erc20 of bootstrap token is total bootstrap balance', async () => {
        const {d, committee} = await fullCommittee([fromMilliOrbs(4000), fromMilliOrbs(3000), fromMilliOrbs(2000), fromMilliOrbs(1000)], 1);

        const PERIOD = MONTH_IN_SECONDS * 2;

        await evmIncreaseTimeForQueries(d.web3, PERIOD);

        for (const c of committee) {
            await c.readyToSync(); // leave committee
        }

        let total = bn(0);
        for (const c of committee) {
            total = total.add(bn(await c.getBootstrapBalance()));
        }
        expect(await d.bootstrapToken.balanceOf(d.feesAndBootstrapRewards.address)).to.bignumber.eq(total);
    });

    it('properly estimates guardian and delegator future rewards', async () => {
        const {d, committee} = await fullCommittee([fromMilliOrbs(4000), fromMilliOrbs(3000), fromMilliOrbs(2000), fromMilliOrbs(1000)], 1);

        const PERIOD = MONTH_IN_SECONDS * 2;

        await evmIncreaseTimeForQueries(d.web3, PERIOD);

        const c0 = committee[0];

        const expectedFees = await generalFeesForDuration(PERIOD, MAX_COMMITTEE);
        const expectedBootstrap = await generalBootstrapForDuration(PERIOD);

        expect(expectedFees).to.be.bignumber.gt(bn(0));
        expect(expectedBootstrap).to.be.bignumber.gt(bn(0));

        expectApproxEq((await d.feesAndBootstrapRewards.estimateFutureFeesAndBootstrapRewards(c0.address, PERIOD)).estimatedFees, expectedFees);
        expectApproxEq((await d.feesAndBootstrapRewards.estimateFutureFeesAndBootstrapRewards(c0.address, PERIOD)).estimatedBootstrapRewards, expectedBootstrap);

        expectApproxEq((await d.feesAndBootstrapRewards.estimateFutureFeesAndBootstrapRewards(c0.address, PERIOD * 2)).estimatedFees, expectedFees.mul(bn(2)));
        expectApproxEq((await d.feesAndBootstrapRewards.estimateFutureFeesAndBootstrapRewards(c0.address, PERIOD * 2)).estimatedBootstrapRewards, expectedBootstrap.mul(bn(2)));

        expectApproxEq((await d.feesAndBootstrapRewards.estimateFutureFeesAndBootstrapRewards(c0.address, PERIOD / 2)).estimatedFees, expectedFees.div(bn(2)));
        expectApproxEq((await d.feesAndBootstrapRewards.estimateFutureFeesAndBootstrapRewards(c0.address, PERIOD / 2)).estimatedBootstrapRewards, expectedBootstrap.div(bn(2)));
    });

    it('returns fees and bootstrap data', async () => {
        const {d, committee} = await fullCommittee([fromMilliOrbs(4000), fromMilliOrbs(3000), fromMilliOrbs(2000), fromMilliOrbs(1000)], 1);

        const PERIOD = MONTH_IN_SECONDS * 2;

        await evmIncreaseTimeForQueries(d.web3, PERIOD);

        const c0 = committee[0];

        const expectedFees = await generalFeesForDuration(PERIOD, MAX_COMMITTEE);
        const expectedBootstrap = await generalBootstrapForDuration(PERIOD);

        expect(expectedFees).to.be.bignumber.gt(bn(0));
        expect(expectedBootstrap).to.be.bignumber.gt(bn(0));

        await d.feesAndBootstrapRewards.withdrawFees(c0.address);
        await d.feesAndBootstrapRewards.withdrawBootstrapFunds(c0.address);

        await evmIncreaseTimeForQueries(d.web3, PERIOD);

        expectApproxEq((await d.feesAndBootstrapRewards.getFeesAndBootstrapData(c0.address)).bootstrapBalance, expectedBootstrap);
        expectApproxEq((await d.feesAndBootstrapRewards.getFeesAndBootstrapData(c0.address)).withdrawnBootstrap, expectedBootstrap);
        expectApproxEq((await d.feesAndBootstrapRewards.getFeesAndBootstrapData(c0.address)).lastBootstrapPerMember, expectedBootstrap.mul(bn(2)));
        expectApproxEq((await d.feesAndBootstrapRewards.getFeesAndBootstrapData(c0.address)).feeBalance, expectedFees);
        expectApproxEq((await d.feesAndBootstrapRewards.getFeesAndBootstrapData(c0.address)).withdrawnFees, expectedFees);
        expectApproxEq((await d.feesAndBootstrapRewards.getFeesAndBootstrapData(c0.address)).lastFeesPerMember, expectedFees.mul(bn(2)));

        expect((await d.feesAndBootstrapRewards.getFeesAndBootstrapData(c0.address)).certified).to.be.false;
        await c0.becomeCertified();
        expect((await d.feesAndBootstrapRewards.getFeesAndBootstrapData(c0.address)).certified).to.be.true;
    });

    // Staking rewards

    it('successfully claims 0 staking rewards ', async () => {
        const d = await Driver.new();

        const p = d.newParticipant();
        const r = await d.stakingRewards.claimStakingRewards(p.address);
        expect(r).to.not.have.a.stakingRewardsClaimedEvent();
    });

    it('assigns staking rewards to committee member, accommodate for participation and stake changes', async () => {
        const {d, committee} = await fullCommittee([fromMilliOrbs(4000), fromMilliOrbs(3000), fromMilliOrbs(2000), fromMilliOrbs(1000)], 1);

        const c0 = committee[0];

        expectApproxEq(await totalStakingRewardsBalance(d, c0), 0);

        // In committee, stake 4000

        await evmIncreaseTimeForQueries(d.web3, MONTH_IN_SECONDS);

        let total = (await stakingRewardsForDuration(d, MONTH_IN_SECONDS, c0, c0)).guardianRewards;
        expectApproxEq(await totalStakingRewardsBalance(d, c0), total);

        await c0.unstake(fromMilliOrbs(2000));

        expectApproxEq(await totalStakingRewardsBalance(d, c0), total);

        // In committee, stake 2000

        await evmIncreaseTimeForQueries(d.web3, MONTH_IN_SECONDS);

        total = total.add((await stakingRewardsForDuration(d, MONTH_IN_SECONDS, c0, c0)).guardianRewards)
        expectApproxEq(await totalStakingRewardsBalance(d, c0), total);

        await c0.stake(fromMilliOrbs(2000));

        // In committee, stake 4000

        expectApproxEq(await totalStakingRewardsBalance(d, c0), total);
        await evmIncreaseTimeForQueries(d.web3, MONTH_IN_SECONDS);

        total = total.add((await stakingRewardsForDuration(d, MONTH_IN_SECONDS, c0, c0)).guardianRewards)
        expectApproxEq(await totalStakingRewardsBalance(d, c0), total);

        await c0.readyToSync();

        // Out of committee

        expectApproxEq(await totalStakingRewardsBalance(d, c0), total);

        await evmIncreaseTimeForQueries(d.web3, MONTH_IN_SECONDS);

        expectApproxEq(await totalStakingRewardsBalance(d, c0), total);

        await c0.readyForCommittee();

        // In committee, stake 4000

        expectApproxEq(await totalStakingRewardsBalance(d, c0), total);

        await evmIncreaseTimeForQueries(d.web3, MONTH_IN_SECONDS);

        total = total.add((await stakingRewardsForDuration(d, MONTH_IN_SECONDS, c0, c0)).guardianRewards)

        expectApproxEq(await totalStakingRewardsBalance(d, c0), total);

        // Claiming entire amount

        let r = await d.stakingRewards.claimStakingRewards(c0.address);

        expect(r).to.have.approx().a.stakingRewardsClaimedEvent({
            addr: c0.address,
        });
        expectApproxEq(getTotalClaimedFromEvent(r), total);

        expect(r).to.have.approx().a.stakedEvent({
            stakeOwner: c0.address,
            amount: total
        });

        expect(total).to.be.bignumber.gt(bn(0));
    });

    it('assigns staking rewards to delegator, accommodate for delegation and stake changes', async () => {
        const {d, committee} = await fullCommittee([fromMilliOrbs(4000), fromMilliOrbs(3000), fromMilliOrbs(2000), fromMilliOrbs(1000)], 1);

        const c0 = committee[0];
        let delegation = c0;

        const d0 = d.newParticipant();
        await d0.delegate(delegation);
        await d0.stake(fromMilliOrbs(1000));

        const PERIOD = MONTH_IN_SECONDS * 2;

        let cTotal = bn(0);
        let dTotal = bn(0);

        const checkAndUpdate = async () => {
            expectApproxEq(await totalStakingRewardsBalance(d, c0), cTotal);
            expectApproxEq(await totalStakingRewardsBalance(d, d0), dTotal);

            await evmIncreaseTimeForQueries(d.web3, PERIOD);

            cTotal = cTotal.add((await stakingRewardsForDuration(d, PERIOD, c0, c0)).guardianRewards);
            expectApproxEq(await totalStakingRewardsBalance(d, c0), cTotal);

            dTotal = dTotal.add((await stakingRewardsForDuration(d, PERIOD, d0, delegation)).delegatorRewards);
            expectApproxEq(await totalStakingRewardsBalance(d, d0), dTotal);
        }

        // In committee, d0 [stake: 1000] -> c0 [stake: 4000]
        await checkAndUpdate();

        await c0.unstake(fromMilliOrbs(2000));

        // In committee, d0 [stake: 1000] -> c0 [stake: 2000]
        await checkAndUpdate();

        await c0.stake(fromMilliOrbs(2000));

        // In committee, d0 [stake: 1000] -> c0 [stake: 4000]
        await checkAndUpdate();

        await c0.readyToSync();

        // Out of committee
        await checkAndUpdate();

        await c0.readyForCommittee();

        // In committee, d0 [stake: 1000] -> c0 [stake: 4000]
        await checkAndUpdate();

        delegation = committee[1];
        await d0.delegate(delegation);

        // In committee, d0 [stake: 1000] -> c1 [stake: 3000]
        await checkAndUpdate();

        await d0.stake(fromMilliOrbs(1000));

        // In committee, d0 [stake: 2000] -> c1 [stake: 3000]
        await checkAndUpdate();

        delegation = d0;
        await d0.delegate(delegation);

        // In committee, d0 -> d0
        await checkAndUpdate();

        delegation = c0;
        await d0.delegate(delegation);

        // In committee, d0 [stake: 2000] -> c0 [stake: 4000]
        await checkAndUpdate();

        // Claim entire amount
        let r = await d.stakingRewards.claimStakingRewards(c0.address);
        expect(r).to.have.approx().a.stakingRewardsClaimedEvent({
            addr: c0.address,
        });
        expectApproxEq(getTotalClaimedFromEvent(r), cTotal);

        r = await d.stakingRewards.claimStakingRewards(d0.address);
        expect(r).to.have.approx().a.stakingRewardsClaimedEvent({
            addr: d0.address,
        });
        expectApproxEq(getTotalClaimedFromEvent(r), dTotal);

        expect(cTotal).to.be.bignumber.gt(bn(0));
        expect(dTotal).to.be.bignumber.gt(bn(0));
    });

    it('emits StakingRewardsAssigned and StakingRewardsClaimed events', async () => {
        const {d, committee} = await fullCommittee([fromMilliOrbs(4000), fromMilliOrbs(3000), fromMilliOrbs(2000), fromMilliOrbs(1000)], 1);

        const c0 = committee[0];
        let delegation = c0;

        const d0 = d.newParticipant();
        await d0.delegate(delegation);
        await d0.stake(fromMilliOrbs(1000));

        const PERIOD = MONTH_IN_SECONDS * 2;

        const allocatedBefore = bn((await d.stakingRewards.getStakingRewardsState()).unclaimedStakingRewards);

        await evmIncreaseTimeForQueries(d.web3, PERIOD);

        const allocatedAfter = bn((await d.stakingRewards.getStakingRewardsState()).unclaimedStakingRewards);

        const c0_delegatorRewardsPerToken_period1 = bn((await d.stakingRewards.getGuardianStakingRewardsData(c0.address)).delegatorRewardsPerToken);
        const stakingRewardsPerWeight_period1 = bn((await d.stakingRewards.getStakingRewardsState()).stakingRewardsPerWeight);

        let r = await d0.stake(fromMilliOrbs(1000));

        expect(r).to.have.a.approx().stakingRewardsAllocatedEvent({
            stakingRewardsPerWeight: bn((await d.stakingRewards.stakingRewardsState()).stakingRewardsPerWeight),
            allocatedRewards: allocatedAfter.sub(allocatedBefore)
        });
        expect(r).to.have.a.approx().guardianStakingRewardsAssignedEvent({
            guardian: c0.address,
            amount: bn((await d.stakingRewards.guardiansStakingRewards(c0.address)).balance),
            totalAwarded: bn((await d.stakingRewards.guardiansStakingRewards(c0.address)).balance),
            delegatorRewardsPerToken: c0_delegatorRewardsPerToken_period1,
            delegatorRewardsPerTokenDelta: c0_delegatorRewardsPerToken_period1,
            stakingRewardsPerWeight: stakingRewardsPerWeight_period1,
            stakingRewardsPerWeightDelta: stakingRewardsPerWeight_period1,
        });
        expect(r).to.have.a.approx().delegatorStakingRewardsAssignedEvent({
            delegator: d0.address,
            amount: bn((await d.stakingRewards.delegatorsStakingRewards(d0.address)).balance),
            totalAwarded: bn((await d.stakingRewards.delegatorsStakingRewards(d0.address)).balance),
            guardian: c0.address,
            delegatorRewardsPerToken: c0_delegatorRewardsPerToken_period1,
            delegatorRewardsPerTokenDelta: c0_delegatorRewardsPerToken_period1,
        });
        
        const guardianRewards = bn((await d.stakingRewards.getGuardianStakingRewardsData(c0.address)).balance);
        const delegatorRewards = bn((await d.stakingRewards.getDelegatorStakingRewardsData(c0.address)).balance);
        r = await d.stakingRewards.claimStakingRewards(c0.address);
        expect(r).to.have.a.approx().stakingRewardsClaimedEvent({
            addr: c0.address,
            claimedGuardianRewards: guardianRewards,
            claimedDelegatorRewards: delegatorRewards,
            totalClaimedGuardianRewards: guardianRewards,
            totalClaimedDelegatorRewards: delegatorRewards
        });
        expectApproxEq(getTotalClaimedFromEvent(r), guardianRewards.add(delegatorRewards));

        await evmIncreaseTimeForQueries(d.web3, PERIOD);

        const guardianRewards2 = bn((await d.stakingRewards.getGuardianStakingRewardsData(c0.address)).balance);
        const delegatorRewards2 = bn((await d.stakingRewards.getDelegatorStakingRewardsData(c0.address)).balance);

        r = await d.stakingRewards.claimStakingRewards(c0.address);
        expect(r).to.have.a.approx().guardianStakingRewardsAssignedEvent({
            guardian: c0.address,
            totalAwarded: guardianRewards.add(guardianRewards2),
            delegatorRewardsPerTokenDelta: bn((await d.stakingRewards.guardiansStakingRewards(c0.address)).delegatorRewardsPerToken).sub(c0_delegatorRewardsPerToken_period1),
            stakingRewardsPerWeightDelta: bn((await d.stakingRewards.stakingRewardsState()).stakingRewardsPerWeight).sub(stakingRewardsPerWeight_period1),
        });
        expect(r).to.have.a.approx().delegatorStakingRewardsAssignedEvent({
            delegator: c0.address,
            totalAwarded: delegatorRewards.add(delegatorRewards2),
            delegatorRewardsPerTokenDelta: bn((await d.stakingRewards.guardiansStakingRewards(c0.address)).delegatorRewardsPerToken).sub(c0_delegatorRewardsPerToken_period1),
        });
        expect(r).to.have.a.approx().stakingRewardsClaimedEvent({
            addr: c0.address,
            claimedGuardianRewards: guardianRewards2,
            claimedDelegatorRewards: delegatorRewards2,
            totalClaimedGuardianRewards: guardianRewards.add(guardianRewards2),
            totalClaimedDelegatorRewards: delegatorRewards.add(delegatorRewards2)
        });
        expectApproxEq(getTotalClaimedFromEvent(r), guardianRewards2.add(delegatorRewards2));
    });

    it('tracks total unclaimed staking rewards', async () => {
        const {d, committee} = await fullCommittee([fromMilliOrbs(4000), fromMilliOrbs(3000), fromMilliOrbs(2000), fromMilliOrbs(1000)], 1);

        const PERIOD = MONTH_IN_SECONDS * 2;

        await evmIncreaseTimeForQueries(d.web3, PERIOD);

        let total = bn(0);
        for (const c of committee) {
            total = total.add(await totalStakingRewardsBalance(d, c));
        }
        expectApproxEq((await d.stakingRewards.getStakingRewardsState()).unclaimedStakingRewards, total);
    });

    it('properly returns guardian and delegator balance', async () => {
        const {d, committee} = await fullCommittee([fromMilliOrbs(4000), fromMilliOrbs(3000), fromMilliOrbs(2000), fromMilliOrbs(1000)], 1);

        const PERIOD = MONTH_IN_SECONDS * 2;

        await evmIncreaseTimeForQueries(d.web3, PERIOD);

        const c0 = committee[0];

        const expectedDelegatorRewards = (await stakingRewardsForDuration(d, PERIOD, c0, c0)).delegatorRewards;
        const expectedGuardianRewards = (await stakingRewardsForDuration(d, PERIOD, c0, c0)).guardianRewards.sub(expectedDelegatorRewards);

        expect(expectedDelegatorRewards).to.be.bignumber.gt(bn(0));
        expect(expectedGuardianRewards).to.be.bignumber.gt(bn(0));

        expectApproxEq((await d.stakingRewards.getStakingRewardsBalance(c0.address)).delegatorStakingRewardsBalance, expectedDelegatorRewards);
        expectApproxEq((await d.stakingRewards.getStakingRewardsBalance(c0.address)).guardianStakingRewardsBalance, expectedGuardianRewards);
    });

    it('properly returns guardian and delegator rewards data', async () => {
        const {d, committee} = await fullCommittee([fromMilliOrbs(4000), fromMilliOrbs(3000), fromMilliOrbs(2000), fromMilliOrbs(1000)], 1);

        const c0 = committee[0];

        const delegator = d.newParticipant();
        await delegator.stake(fromMilliOrbs(1000));
        await delegator.delegate(c0);

        const PERIOD = MONTH_IN_SECONDS * 5;

        await evmIncreaseTimeForQueries(d.web3, PERIOD);

        const c0_expectedDelegatorRewards = (await stakingRewardsForDuration(d, PERIOD, c0, c0)).delegatorRewards;
        const c0_expectedGuardianRewards = (await stakingRewardsForDuration(d, PERIOD, c0, c0)).guardianRewards.sub(c0_expectedDelegatorRewards);

        const delegator_expectedDelegatorRewards = (await stakingRewardsForDuration(d, PERIOD, delegator, c0)).delegatorRewards;

        expect(c0_expectedDelegatorRewards).to.be.bignumber.gt(bn(0));
        expect(c0_expectedGuardianRewards).to.be.bignumber.gt(bn(0));
        expect(delegator_expectedDelegatorRewards).to.be.bignumber.gt(bn(0));

        await d.stakingRewards.claimStakingRewards(c0.address);
        await c0.unstake(c0_expectedDelegatorRewards.add(c0_expectedGuardianRewards));

        await evmIncreaseTimeForQueries(d.web3, PERIOD);

        expectApproxEq(bn((await d.stakingRewards.getGuardianStakingRewardsData(c0.address)).claimed), c0_expectedGuardianRewards)
        expectApproxEq(bn((await d.stakingRewards.getGuardianStakingRewardsData(c0.address)).balance), c0_expectedGuardianRewards)
        expectApproxEq(bn((await d.stakingRewards.getGuardianStakingRewardsData(c0.address)).lastStakingRewardsPerWeight), (await d.stakingRewards.getStakingRewardsState()).stakingRewardsPerWeight);
        expectApproxEq(bn((await d.stakingRewards.getGuardianStakingRewardsData(c0.address)).stakingRewardsPerWeightDelta), bn((await d.stakingRewards.getStakingRewardsState()).stakingRewardsPerWeight).div(bn(2)));
        expectApproxEq(bn((await d.stakingRewards.getGuardianStakingRewardsData(c0.address)).delegatorRewardsPerToken), c0_expectedDelegatorRewards.mul(bn(2)).mul(bn(10).pow(bn(18))).div(fromMilliOrbs(4000)));
        expectApproxEq(bn((await d.stakingRewards.getGuardianStakingRewardsData(c0.address)).delegatorRewardsPerTokenDelta), c0_expectedDelegatorRewards.mul(bn(10).pow(bn(18))).div(fromMilliOrbs(4000)));

        expectApproxEq(bn((await d.stakingRewards.getDelegatorStakingRewardsData(c0.address)).balance), c0_expectedDelegatorRewards);
        expectApproxEq(bn((await d.stakingRewards.getDelegatorStakingRewardsData(c0.address)).claimed), c0_expectedDelegatorRewards);
        expect((await d.stakingRewards.getDelegatorStakingRewardsData(c0.address)).guardian).to.eq(c0.address);
        expectApproxEq(bn((await d.stakingRewards.getDelegatorStakingRewardsData(c0.address)).lastDelegatorRewardsPerToken), c0_expectedDelegatorRewards.mul(bn(2)).mul(bn(10).pow(bn(18))).div(fromMilliOrbs(4000)));
        expectApproxEq(bn((await d.stakingRewards.getDelegatorStakingRewardsData(c0.address)).delegatorRewardsPerTokenDelta), c0_expectedDelegatorRewards.mul(bn(10).pow(bn(18))).div(fromMilliOrbs(4000)));

        expectApproxEq(bn((await d.stakingRewards.getDelegatorStakingRewardsData(delegator.address)).balance), delegator_expectedDelegatorRewards.mul(bn(2)));
        expectApproxEq(bn((await d.stakingRewards.getDelegatorStakingRewardsData(delegator.address)).claimed), bn(0));
        expect((await d.stakingRewards.getDelegatorStakingRewardsData(delegator.address)).guardian).to.eq(c0.address);
    });

    it('properly estimates guardian and delegator future rewards', async () => {
        const {d, committee} = await fullCommittee([fromMilliOrbs(4000), fromMilliOrbs(3000), fromMilliOrbs(2000), fromMilliOrbs(1000)], 1);

        const PERIOD = MONTH_IN_SECONDS * 2;

        await evmIncreaseTimeForQueries(d.web3, PERIOD);

        const c0 = committee[0];

        const expectedDelegatorRewards = (await stakingRewardsForDuration(d, PERIOD, c0, c0)).delegatorRewards;
        const expectedGuardianRewards = (await stakingRewardsForDuration(d, PERIOD, c0, c0)).guardianRewards.sub(expectedDelegatorRewards);

        expect(expectedDelegatorRewards).to.be.bignumber.gt(bn(0));
        expect(expectedGuardianRewards).to.be.bignumber.gt(bn(0));

        expectApproxEq((await d.stakingRewards.estimateFutureRewards(c0.address, PERIOD)).estimatedDelegatorStakingRewards, expectedDelegatorRewards);
        expectApproxEq((await d.stakingRewards.estimateFutureRewards(c0.address, PERIOD)).estimatedGuardianStakingRewards, expectedGuardianRewards);

        expectApproxEq((await d.stakingRewards.estimateFutureRewards(c0.address, PERIOD * 2)).estimatedDelegatorStakingRewards, expectedDelegatorRewards.mul(bn(2)));
        expectApproxEq((await d.stakingRewards.estimateFutureRewards(c0.address, PERIOD * 2)).estimatedGuardianStakingRewards, expectedGuardianRewards.mul(bn(2)));

        expectApproxEq((await d.stakingRewards.estimateFutureRewards(c0.address, PERIOD / 2)).estimatedDelegatorStakingRewards, expectedDelegatorRewards.div(bn(2)));
        expectApproxEq((await d.stakingRewards.estimateFutureRewards(c0.address, PERIOD / 2)).estimatedGuardianStakingRewards, expectedGuardianRewards.div(bn(2)));
    });

    it('properly assigns staking rewards to a guardian who becomes a delegator', async () => {
        const {d, committee} = await fullCommittee([fromMilliOrbs(4000), fromMilliOrbs(3000), fromMilliOrbs(2000), fromMilliOrbs(1000)], 1);

        const c0 = committee[0];
        const c1 = committee[1];

        const PERIOD = MONTH_IN_SECONDS * 2;

        let c0Total = bn(0);
        let c1Total = bn(0);

        expectApproxEq(await totalStakingRewardsBalance(d, c0), c0Total);
        expectApproxEq(await totalStakingRewardsBalance(d, c1), c1Total);

        await evmIncreaseTimeForQueries(d.web3, PERIOD);

        c0Total = c0Total.add((await stakingRewardsForDuration(d, PERIOD, c0, c0)).guardianRewards);
        expectApproxEq(await totalStakingRewardsBalance(d, c0), c0Total);
        c1Total = c1Total.add((await stakingRewardsForDuration(d, PERIOD, c1, c1)).guardianRewards);
        expectApproxEq(await totalStakingRewardsBalance(d, c1), c1Total);

        c0.delegate(c1);

        expectApproxEq(await totalStakingRewardsBalance(d, c0), c0Total);
        expectApproxEq(await totalStakingRewardsBalance(d, c1), c1Total);

        await evmIncreaseTimeForQueries(d.web3, PERIOD);

        c0Total = c0Total.add((await stakingRewardsForDuration(d, PERIOD, c0, c1)).delegatorRewards);
        expectApproxEq(await totalStakingRewardsBalance(d, c0), c0Total);

        c1Total = c1Total.add((await stakingRewardsForDuration(d, PERIOD, c0, c1)).guardianRewards);
        expectApproxEq(await totalStakingRewardsBalance(d, c1), c1Total);

        // Claim entire amount
        let r = await d.stakingRewards.claimStakingRewards(c0.address);
        expect(r).to.have.approx().a.stakingRewardsClaimedEvent({
            addr: c0.address
        });
        expectApproxEq(getTotalClaimedFromEvent(r), c0Total);

        r = await d.stakingRewards.claimStakingRewards(c1.address);
        expect(r).to.have.approx().a.stakingRewardsClaimedEvent({
            addr: c1.address
        });
        expectApproxEq(getTotalClaimedFromEvent(r), c1Total);

        expect(c0Total).to.be.bignumber.gt(bn(0));
        expect(c1Total).to.be.bignumber.gt(bn(0));
    });

    it('properly handles a change in maxCommitteeSize', async () => {
        const {d, committee} = await fullCommittee([fromMilliOrbs(4000), fromMilliOrbs(3000), fromMilliOrbs(2000), fromMilliOrbs(1000)], 1);

        const c0 = committee[0];
        const c2 = committee[2];
        const c3 = committee[3];

        const PERIOD = MONTH_IN_SECONDS * 2;

        let c0Total = bn(0);
        let c2Total = bn(0);
        let c3Total = bn(0);

        expectApproxEq(await totalStakingRewardsBalance(d, c0), c0Total);
        expectApproxEq(await totalStakingRewardsBalance(d, c2), c2Total);
        expectApproxEq(await totalStakingRewardsBalance(d, c3), c3Total);

        await evmIncreaseTimeForQueries(d.web3, PERIOD);

        c0Total = c0Total.add((await stakingRewardsForDuration(d, PERIOD, c0, c0)).guardianRewards);
        expectApproxEq(await totalStakingRewardsBalance(d, c0), c0Total);
        c2Total = c2Total.add((await stakingRewardsForDuration(d, PERIOD, c2, c2)).guardianRewards);
        expectApproxEq(await totalStakingRewardsBalance(d, c2), c2Total);
        c3Total = c3Total.add((await stakingRewardsForDuration(d, PERIOD, c3, c3)).guardianRewards);
        expectApproxEq(await totalStakingRewardsBalance(d, c3), c3Total);

        await d.committee.setMaxCommitteeSize(2, {from: d.functionalManager.address});

        expectApproxEq(await totalStakingRewardsBalance(d, c0), c0Total);
        expectApproxEq(await totalStakingRewardsBalance(d, c2), c2Total);
        expectApproxEq(await totalStakingRewardsBalance(d, c3), c3Total);

        await evmIncreaseTimeForQueries(d.web3, PERIOD);

        c0Total = c0Total.add((await stakingRewardsForDuration(d, PERIOD, c0, c0)).guardianRewards);
        expectApproxEq(await totalStakingRewardsBalance(d, c0), c0Total);

        expectApproxEq(await totalStakingRewardsBalance(d, c2), c2Total);
        expectApproxEq(await totalStakingRewardsBalance(d, c3), c3Total);

        // Claim entire amount
        let r = await d.stakingRewards.claimStakingRewards(c0.address);
        expect(r).to.have.approx().a.stakingRewardsClaimedEvent({
            addr: c0.address
        });
        expectApproxEq(getTotalClaimedFromEvent(r), c0Total);

        r = await d.stakingRewards.claimStakingRewards(c2.address);
        expect(r).to.have.approx().a.stakingRewardsClaimedEvent({
            addr: c2.address
        });
        expectApproxEq(getTotalClaimedFromEvent(r), c2Total);

        r = await d.stakingRewards.claimStakingRewards(c3.address);
        expect(r).to.have.approx().a.stakingRewardsClaimedEvent({
            addr: c3.address
        });
        expectApproxEq(getTotalClaimedFromEvent(r), c3Total);

        expect(c0Total).to.be.bignumber.gt(bn(0));
        expect(c3Total).to.be.bignumber.gt(bn(0));
    });

    it('enforces annual staking rewards cap', async () => {
        const {d, committee} = await fullCommittee([STAKING_REWARDS_ANNUAL_CAP.mul(bn(100000)).div(STAKING_REWARDS_ANNUAL_RATE).mul(bn(2)), bn(1), bn(1), bn(1)]);

        await evmIncreaseTimeForQueries(d.web3, YEAR_IN_SECONDS);

        expectApproxEq(await totalStakingRewardsBalance(d, committee[0]), STAKING_REWARDS_ANNUAL_CAP);
    })

    it('enforces annual staking rewards cap when set to zero', async () => {
        const {d, committee} = await fullCommittee(null, 1, {stakingRewardsAnnualCap: bn(0)});

        await evmIncreaseTimeForQueries(d.web3, YEAR_IN_SECONDS);

        expect(await totalStakingRewardsBalance(d, committee[0])).to.bignumber.eq(bn(0));
    })

    it('enforces effective stake limit (min self stake)', async () => {
        const {d, committee} = await fullCommittee([fromMilliOrbs(MIN_SELF_STAKE_PERCENT_MILLE), bn(1), bn(1), bn(1)], 1, {stakingRewardsAnnualCap: fromMilliOrbs(100000000000)});
        const c0 = committee[0];
        const d0 = d.newParticipant();
        const dStake = fromMilliOrbs(bn(100000).sub(MIN_SELF_STAKE_PERCENT_MILLE));
        await d0.stake(dStake);
        await d0.delegate(c0);

        await evmIncreaseTimeForQueries(d.web3, YEAR_IN_SECONDS);

        let cTotal = bn((await stakingRewardsForDuration(d, YEAR_IN_SECONDS, c0, c0)).guardianRewards);
        expectApproxEq(await totalStakingRewardsBalance(d, c0), cTotal);
        let dTotal = bn((await stakingRewardsForDuration(d, YEAR_IN_SECONDS, d0, c0)).delegatorRewards);
        expectApproxEq(await totalStakingRewardsBalance(d, d0), dTotal);

        const allRewards0 = cTotal.add(dTotal);

        await d0.stake(dStake);

        await evmIncreaseTimeForQueries(d.web3, YEAR_IN_SECONDS);

        cTotal = cTotal.add(bn((await stakingRewardsForDuration(d, YEAR_IN_SECONDS, c0, c0)).guardianRewards));
        expectApproxEq(await totalStakingRewardsBalance(d, c0), cTotal);
        dTotal = dTotal.add(bn((await stakingRewardsForDuration(d, YEAR_IN_SECONDS, d0, c0)).delegatorRewards));
        expectApproxEq(await totalStakingRewardsBalance(d, d0), dTotal);

        const allRewards1 = cTotal.add(dTotal);

        expectApproxEq(allRewards1.div(bn(2)), allRewards0); // rate shouldn't have changed as the effective stake remained the same for the two periods
    })

    it('performs emergency withdrawal from feesAndBootstrapRewards only by the migration manager', async () => {
        const d = await Driver.new();
        const p = d.newParticipant();
        await p.assignAndTransferOrbs(bn(1000), d.feesAndBootstrapRewards.address);
        await p.assignAndTransferExternalToken(bn(2000), d.feesAndBootstrapRewards.address);

        await expectRejected(d.feesAndBootstrapRewards.emergencyWithdraw(d.erc20.address,{from: d.functionalManager.address}), /sender is not the migration manager/);
        let r = await d.feesAndBootstrapRewards.emergencyWithdraw(d.erc20.address, {from: d.migrationManager.address});
        expect(r).to.have.a.emergencyWithdrawalEvent({addr: d.migrationManager.address, token: d.erc20.address});
        expect(await d.erc20.balanceOf(d.migrationManager.address)).to.bignumber.eq(bn(1000));
        expect(await d.erc20.balanceOf(d.feesAndBootstrapRewards.address)).to.bignumber.eq(bn(0));

        r = await d.feesAndBootstrapRewards.emergencyWithdraw(d.bootstrapToken.address, {from: d.migrationManager.address});
        expect(r).to.have.a.emergencyWithdrawalEvent({addr: d.migrationManager.address, token: d.bootstrapToken.address});
        expect(await d.bootstrapToken.balanceOf(d.migrationManager.address)).to.bignumber.eq(bn(2000));
        expect(await d.bootstrapToken.balanceOf(d.feesAndBootstrapRewards.address)).to.bignumber.eq(bn(0));
    });

    it('performs emergency withdrawal from stakingRewards only by the migration manager', async () => {
        const d = await Driver.new();
        const p = d.newParticipant();
        await p.assignAndTransferOrbs(bn(1000), d.stakingRewards.address);

        await expectRejected(d.stakingRewards.emergencyWithdraw(d.erc20.address, {from: d.functionalManager.address}), /sender is not the migration manager/);
        let r = await d.stakingRewards.emergencyWithdraw(d.erc20.address, {from: d.migrationManager.address});
        expect(r).to.have.a.emergencyWithdrawalEvent({addr: d.migrationManager.address, token: d.erc20.address});

        expect(await d.erc20.balanceOf(d.migrationManager.address)).to.bignumber.eq(bn(1000));
        expect(await d.erc20.balanceOf(d.stakingRewards.address)).to.bignumber.eq(bn(0));
    });

    it('gets settings from feesAndBootstrapRewards', async () => {
        const opts = {
            generalCommitteeAnnualBootstrap: fromMilliOrbs(10),
            certifiedCommitteeAnnualBootstrap: fromMilliOrbs(20),
        };
        const d = await Driver.new(opts as any);

        expect((await d.feesAndBootstrapRewards.getSettings()).generalCommitteeAnnualBootstrap).to.eq(opts.generalCommitteeAnnualBootstrap.toString());
        expect((await d.feesAndBootstrapRewards.getSettings()).certifiedCommitteeAnnualBootstrap).to.eq(opts.certifiedCommitteeAnnualBootstrap.toString());
        expect((await d.feesAndBootstrapRewards.getSettings()).rewardAllocationActive).to.be.true;
    });

    it('gets settings from stakingRewards', async () => {
        const opts = {
            defaultDelegatorsStakingRewardsPercentMille: 3,
            stakingRewardsAnnualRateInPercentMille: 4,
            stakingRewardsAnnualCap: fromMilliOrbs(50)
        };
        const d = await Driver.new(opts as any);

        expect((await d.stakingRewards.getSettings()).defaultDelegatorsStakingRewardsPercentMille).to.eq(opts.defaultDelegatorsStakingRewardsPercentMille.toString());
        expect((await d.stakingRewards.getSettings()).annualStakingRewardsRatePercentMille).to.eq(opts.stakingRewardsAnnualRateInPercentMille.toString());
        expect((await d.stakingRewards.getSettings()).annualStakingRewardsCap).to.eq(opts.stakingRewardsAnnualCap.toString());
        expect((await d.stakingRewards.getSettings()).rewardAllocationActive).to.be.true;
    });

    it("ensures only migration manager can activate and deactivate (stakingRewards)", async () => {
        const d = await Driver.new();

        await expectRejected(d.stakingRewards.deactivateRewardDistribution({from: d.functionalManager.address}), /sender is not the migration manager/);
        let r = await d.stakingRewards.deactivateRewardDistribution({from: d.migrationManager.address});
        expect(r).to.have.a.rewardDistributionDeactivatedEvent();

        await expectRejected(d.stakingRewards.activateRewardDistribution(await d.web3.txTimestamp(r), {from: d.functionalManager.address}), /sender is not the migration manager/);
        r = await d.stakingRewards.activateRewardDistribution(await d.web3.txTimestamp(r), {from: d.migrationManager.address});
        expect(r).to.have.a.rewardDistributionActivatedEvent();
    });

    it("ensures only migration manager can activate and deactivate (feesAndBootstrapRewards)", async () => {
        const d = await Driver.new();

        await expectRejected(d.feesAndBootstrapRewards.deactivateRewardDistribution({from: d.functionalManager.address}), /sender is not the migration manager/);
        let r = await d.feesAndBootstrapRewards.deactivateRewardDistribution({from: d.migrationManager.address});
        expect(r).to.have.a.rewardDistributionDeactivatedEvent();

        await expectRejected(d.feesAndBootstrapRewards.activateRewardDistribution(await d.web3.txTimestamp(r), {from: d.functionalManager.address}), /sender is not the migration manager/);
        r = await d.feesAndBootstrapRewards.activateRewardDistribution(await d.web3.txTimestamp(r), {from: d.migrationManager.address});
        expect(r).to.have.a.rewardDistributionActivatedEvent();
    });

    it("allows anyone to migrate staking rewards to a new contract (stakingRewards)", async () => {
        const {d, committee} = await fullCommittee();

        const c0 = committee[0];
        const c1 = committee[1];

        await evmIncreaseTime(d.web3, YEAR_IN_SECONDS);

        await expectRejected(d.stakingRewards.migrateRewardsBalance([c0.address, c1.address]), /Reward distribution must be deactivated for migration/);

        let r = await d.stakingRewards.deactivateRewardDistribution({from: d.migrationManager.address});
        expect(r).to.have.a.rewardDistributionDeactivatedEvent({});

        // Migrating to the same contract should revert
        await expectRejected(d.stakingRewards.migrateRewardsBalance([c0.address, c1.address]), /New rewards contract is not set/);

        // trigger reward assignment
        await c0.stake(1);
        await c0.readyToSync();
        await c0.readyForCommittee();

        // trigger reward assignment
        await c1.stake(1);
        await c1.readyToSync();
        await c1.readyForCommittee();

        const c0StakingBalance = bn(await totalStakingRewardsBalance(d, c0));
        expect(c0StakingBalance).to.be.bignumber.greaterThan(bn(0));

        const c0GuardianStakingBalance = bn((await (d.stakingRewards as any).guardiansStakingRewards(c0.address)).balance);
        const c0DelegatorStakingBalance = bn((await (d.stakingRewards as any).delegatorsStakingRewards(c0.address)).balance);

        expectApproxEq(c0GuardianStakingBalance.add(c0DelegatorStakingBalance), c0StakingBalance);

        const c1StakingBalance = bn(await totalStakingRewardsBalance(d, c1));
        expect(c1StakingBalance).to.be.bignumber.greaterThan(bn(0));

        const c1GuardianStakingBalance = bn((await (d.stakingRewards as any).guardiansStakingRewards(c1.address)).balance);
        const c1DelegatorStakingBalance = bn((await (d.stakingRewards as any).delegatorsStakingRewards(c1.address)).balance);

        expectApproxEq(c1GuardianStakingBalance.add(c1DelegatorStakingBalance), c1StakingBalance);

        const newRewardsContract = await d.web3.deploy('StakingRewards', [d.contractRegistry.address, d.registryAdmin.address, d.erc20.address,
          defaultDriverOptions.stakingRewardsAnnualRateInPercentMille,
          defaultDriverOptions.stakingRewardsAnnualCap,
          defaultDriverOptions.defaultDelegatorsStakingRewardsPercentMille,
          defaultDriverOptions.maxDelegatorsStakingRewardsPercentMille,
          ZERO_ADDR,
          []
        ], null, d.session);
        await d.contractRegistry.setContract('stakingRewards', newRewardsContract.address, true, {from: d.registryAdmin.address});

        // migrate to the new contract
        r = await d.stakingRewards.migrateRewardsBalance([c0.address, c1.address]);

        // c0
        expect(r).to.have.withinContract(newRewardsContract).a.approx().stakingRewardsBalanceMigrationAcceptedEvent({
          from: d.stakingRewards.address,
          addr: c0.address,
          guardianStakingRewards: c0GuardianStakingBalance.toString(),
          delegatorStakingRewards: c0DelegatorStakingBalance.toString(),
        });
        expect(r).to.have.withinContract(d.stakingRewards).a.approx().stakingRewardsBalanceMigratedEvent({
          addr: c0.address,
          guardianStakingRewards: c0GuardianStakingBalance,
          delegatorStakingRewards: c0DelegatorStakingBalance,
          toRewardsContract: newRewardsContract.address
        });
        expect(bn(await totalStakingRewardsBalance(d, c0))).to.bignumber.eq(bn(0));
        const c0MigratedBalance = await newRewardsContract.getStakingRewardsBalance(c0.address);
        expectApproxEq(bn(c0MigratedBalance.guardianStakingRewardsBalance).add(bn(c0MigratedBalance.delegatorStakingRewardsBalance)), c0StakingBalance);

        // c1
        expect(r).to.have.withinContract(newRewardsContract).a.approx().stakingRewardsBalanceMigrationAcceptedEvent({
          from: d.stakingRewards.address,
          addr: c1.address,
          guardianStakingRewards: c1GuardianStakingBalance.toString(),
          delegatorStakingRewards: c1DelegatorStakingBalance.toString(),
        });
        expect(r).to.have.withinContract(d.stakingRewards).a.approx().stakingRewardsBalanceMigratedEvent({
          addr: c1.address,
          guardianStakingRewards: c1GuardianStakingBalance,
          delegatorStakingRewards: c1DelegatorStakingBalance,
          toRewardsContract: newRewardsContract.address
        });
        expect(bn(await totalStakingRewardsBalance(d, c1))).to.bignumber.eq(bn(0));

        const c1MigratedBalance = await newRewardsContract.getStakingRewardsBalance(c1.address);
        expectApproxEq(bn(c1MigratedBalance.guardianStakingRewardsBalance).add(bn(c1MigratedBalance.delegatorStakingRewardsBalance)), c1StakingBalance);

        expect(r).to.have.withinContract(d.erc20).a.approx().transferEvent({
            from: d.stakingRewards.address,
            to: newRewardsContract.address,
            value: bn(c1GuardianStakingBalance).add(c1DelegatorStakingBalance).add(bn(c0GuardianStakingBalance).add(c0DelegatorStakingBalance))
        });

        // anyone can call acceptMigration
        const migrator = d.newParticipant();
        await migrator.assignAndApproveOrbs(180, newRewardsContract.address);
        r = await newRewardsContract.acceptRewardsBalanceMigration([c0.address, c1.address], [10, 20], [30, 40], {from: migrator.address});
        expect(r).to.have.withinContract(newRewardsContract).a.stakingRewardsBalanceMigrationAcceptedEvent({
            from: migrator.address,
            addr: c0.address,
            guardianStakingRewards: bn(10),
            delegatorStakingRewards: bn(30),
        });
        expect(r).to.have.withinContract(newRewardsContract).a.stakingRewardsBalanceMigrationAcceptedEvent({
            from: migrator.address,
            addr: c1.address,
            guardianStakingRewards: bn(20),
            delegatorStakingRewards: bn(40),
        });
        expect(r).to.have.withinContract(d.erc20).a.approx().transferEvent({
            from: migrator.address,
            to: newRewardsContract.address,
            value: bn(100)
        });
    });

    it("allows anyone to migrate staking rewards to a new contract (feesAndBootstrapRewards)", async () => {
        const {d, committee} = await fullCommittee();

        const c0 = committee[0];

        await evmIncreaseTime(d.web3, YEAR_IN_SECONDS);

        await expectRejected(d.feesAndBootstrapRewards.migrateRewardsBalance(c0.address), /Reward distribution must be deactivated for migration/);

        let r = await d.feesAndBootstrapRewards.deactivateRewardDistribution({from: d.migrationManager.address});
        expect(r).to.have.a.rewardDistributionDeactivatedEvent({});

        // Migrating to the same contract should revert
        await expectRejected(d.feesAndBootstrapRewards.migrateRewardsBalance(c0.address), /New rewards contract is not set/);

        // trigger reward assignment
        await c0.stake(1);
        await c0.readyToSync();
        await c0.readyForCommittee();

        const c0BootstrapBalance = bn(await c0.getBootstrapBalance());
        expect(c0BootstrapBalance).to.be.bignumber.greaterThan(bn(0));

        const c0FeeBalance = bn(await c0.getFeeBalance());
        expect(c0FeeBalance).to.be.bignumber.greaterThan(bn(0));

        const newRewardsContract = await d.web3.deploy('FeesAndBootstrapRewards', [d.contractRegistry.address, d.registryAdmin.address, d.erc20.address, d.bootstrapToken.address,
          defaultDriverOptions.generalCommitteeAnnualBootstrap,
          defaultDriverOptions.certifiedCommitteeAnnualBootstrap
        ], null, d.session);
        await d.contractRegistry.setContract('feesAndBootstrapRewards', newRewardsContract.address, true, {from: d.registryAdmin.address});

        // migrate to the new contract
        r = await d.feesAndBootstrapRewards.migrateRewardsBalance(c0.address);
        expect(r).to.have.withinContract(newRewardsContract).a.approx().feesAndBootstrapRewardsBalanceMigrationAcceptedEvent({
          from: d.feesAndBootstrapRewards.address,
          guardian: c0.address,
          bootstrapRewards: c0BootstrapBalance.toString(),
          fees: c0FeeBalance.toString()
        });
        expect(r).to.have.withinContract(d.feesAndBootstrapRewards).a.approx().feesAndBootstrapRewardsBalanceMigratedEvent({
          guardian: c0.address,
          bootstrapRewards: c0BootstrapBalance,
          fees: c0FeeBalance,
          toRewardsContract: newRewardsContract.address
        });
        expect(r).to.have.withinContract(d.erc20).a.approx().transferEvent({
            from: d.feesAndBootstrapRewards.address,
            to: newRewardsContract.address,
            value: bn(c0FeeBalance)
        });
        expect(r).to.have.withinContract(d.bootstrapToken).a.approx().transferEvent({
            from: d.feesAndBootstrapRewards.address,
            to: newRewardsContract.address,
            value: bn(c0BootstrapBalance)
        });
        expect(bn(await c0.getBootstrapBalance())).to.bignumber.eq(bn(0));
        expect(bn(await c0.getFeeBalance())).to.bignumber.eq(bn(0));
        expectApproxEq(bn((await newRewardsContract.getFeesAndBootstrapBalance(c0.address)).bootstrapBalance), c0BootstrapBalance);
        expectApproxEq(bn((await newRewardsContract.getFeesAndBootstrapBalance(c0.address)).feeBalance), c0FeeBalance);

        // anyone can call acceptMigration
        const migrator = d.newParticipant();
        await migrator.assignAndApproveOrbs(180, newRewardsContract.address);
        await migrator.assignAndApproveExternalToken(100, newRewardsContract.address);
        r = await newRewardsContract.acceptRewardsBalanceMigration(c0.address,80, 100, {from: migrator.address});
        expect(r).to.have.withinContract(newRewardsContract).a.feesAndBootstrapRewardsBalanceMigrationAcceptedEvent({
            from: migrator.address,
            guardian: c0.address,
            fees: bn(80),
            bootstrapRewards: bn(100)
        });
        expect(r).to.have.withinContract(d.erc20).a.approx().transferEvent({
            from: migrator.address,
            to: newRewardsContract.address,
            value: bn(80)
        });
        expect(r).to.have.withinContract(d.bootstrapToken).a.approx().transferEvent({
            from: migrator.address,
            to: newRewardsContract.address,
            value: bn(100)
        });

    });

    it("updates guardian delegator rewards ratio", async () => {
        const {d, committee} = await fullCommittee();

        const d0 = d.newParticipant();
        await d0.stake(fromMilliOrbs(1000));
        const c0 = committee[0];
        await d0.delegate(c0);

        const PERIOD = MONTH_IN_SECONDS*2;

        let cTotal = bn(0);
        let dTotal = bn(0);

        const checkAndUpdate = async (updater?: ()=>Promise<void>) => {
            expectApproxEq(await totalStakingRewardsBalance(d, c0), cTotal);
            expectApproxEq(await totalStakingRewardsBalance(d, d0), dTotal);

            if (updater) {
                await updater();
            }
            await evmIncreaseTimeForQueries(d.web3, PERIOD);

            cTotal = cTotal.add((await stakingRewardsForDuration(d, PERIOD, c0, c0)).guardianRewards);
            expectApproxEq(await totalStakingRewardsBalance(d, c0), cTotal);

            dTotal = dTotal.add((await stakingRewardsForDuration(d, PERIOD, d0, c0)).delegatorRewards);
            expectApproxEq(await totalStakingRewardsBalance(d, d0), dTotal);
        }

        await checkAndUpdate();

        await checkAndUpdate(async () => {
            let r = await d.stakingRewards.setGuardianDelegatorsStakingRewardsPercentMille(bn(100000).sub(DELEGATOR_REWARDS_PERCENT_MILLE), {from: c0.address});
            expect(r).to.have.a.guardianDelegatorsStakingRewardsPercentMilleUpdatedEvent({
                guardian: c0.address,
                delegatorsStakingRewardsPercentMille: bn(100000).sub(DELEGATOR_REWARDS_PERCENT_MILLE)
            });
        });

        await checkAndUpdate(async () => {
            await c0.stake(1); // trigger reward assignment on the previous period
            let r = await d.stakingRewards.setMaxDelegatorsStakingRewardsPercentMille(bn(11000), {from: d.functionalManager.address});
            expect(r).to.have.a.maxDelegatorsStakingRewardsChangedEvent({
                maxDelegatorsStakingRewardsPercentMille: bn(11000)
            });
        });

        // Claim entire amount
        let r = await d.stakingRewards.claimStakingRewards(c0.address);
        expect(r).to.have.approx().a.stakingRewardsClaimedEvent({
            addr: c0.address
        });
        expectApproxEq(getTotalClaimedFromEvent(r), cTotal);

        r = await d.stakingRewards.claimStakingRewards(d0.address);
        expect(r).to.have.approx().a.stakingRewardsClaimedEvent({
            addr: d0.address
        });
        expectApproxEq(getTotalClaimedFromEvent(r), dTotal);

        expect(cTotal).to.be.bignumber.gt(bn(0));
        expect(dTotal).to.be.bignumber.gt(bn(0));
    });

    it("does not allow setting guardian and default reward ratios bigger than the maximum", async () => {
        const d = await Driver.new({maxDelegatorsStakingRewardsPercentMille: 55000, defaultDelegatorsStakingRewardsPercentMille: 55000});
        const p = d.newParticipant();

        await expectRejected(d.stakingRewards.setGuardianDelegatorsStakingRewardsPercentMille(55001), /delegatorRewardsPercentMille must not be larger than maxDelegatorsStakingRewardsPercentMille/)
        let r = await d.stakingRewards.setGuardianDelegatorsStakingRewardsPercentMille(55000);
        expect(r).to.have.a.guardianDelegatorsStakingRewardsPercentMilleUpdatedEvent({delegatorsStakingRewardsPercentMille: bn(55000)})

        await expectRejected(d.stakingRewards.setGuardianDelegatorsStakingRewardsPercentMille(55001, {from: d.functionalManager.address}), /delegatorRewardsPercentMille must not be larger than maxDelegatorsStakingRewardsPercentMille/);
    });

    it("considers max allowed ratio when getting the guardian ratio", async () => {
        const d = await Driver.new({maxDelegatorsStakingRewardsPercentMille: 55000, defaultDelegatorsStakingRewardsPercentMille: 55000});
        const p = d.newParticipant();

        let r = await d.stakingRewards.setGuardianDelegatorsStakingRewardsPercentMille(55000);
        expect(r).to.have.a.guardianDelegatorsStakingRewardsPercentMilleUpdatedEvent({delegatorsStakingRewardsPercentMille: bn(55000)})

        expect(await d.stakingRewards.getGuardianDelegatorsStakingRewardsPercentMille(p.address)).to.bignumber.eq(bn(55000));
        await d.stakingRewards.setMaxDelegatorsStakingRewardsPercentMille(20000, {from: d.functionalManager.address});
        expect(await d.stakingRewards.getGuardianDelegatorsStakingRewardsPercentMille(p.address)).to.bignumber.eq(bn(20000));
    });

    it("does not update rewards when deactivated (stakingRewards)", async () => {
        const {d, committee} = await fullCommittee();

        const PERIOD = MONTH_IN_SECONDS * 2;

        await evmIncreaseTimeForQueries(d.web3, PERIOD);

        const c0StakingBefore = bn(await totalStakingRewardsBalance(d, committee[0]));

        expect(c0StakingBefore).to.be.bignumber.gt(bn(0));

        let r = await d.stakingRewards.deactivateRewardDistribution({from: d.migrationManager.address});
        expect(r).to.have.a.rewardDistributionDeactivatedEvent();
        const deactivationTime = await d.web3.txTimestamp(r);

        const c0StakingAfter = bn(await totalStakingRewardsBalance(d, committee[0]));

        expectApproxEq(c0StakingBefore, c0StakingAfter);

        await evmIncreaseTimeForQueries(d.web3, PERIOD);

        expect(await totalStakingRewardsBalance(d, committee[0])).to.be.bignumber.eq(c0StakingAfter);

        await evmIncreaseTimeForQueries(d.web3, PERIOD);

        expect(await totalStakingRewardsBalance(d, committee[0])).to.be.bignumber.eq(c0StakingAfter);

        r = await d.stakingRewards.activateRewardDistribution(deactivationTime, {from: d.migrationManager.address});
        expect(r).to.have.a.rewardDistributionActivatedEvent();

        expectApproxEq(await totalStakingRewardsBalance(d, committee[0]), c0StakingAfter.mul(bn(3)));
    });

    it("does not update rewards when deactivated (feesAndBootstrapRewards)", async () => {
        const {d, committee} = await fullCommittee();

        const PERIOD = MONTH_IN_SECONDS * 2;

        await evmIncreaseTimeForQueries(d.web3, PERIOD);

        const c0BootstrapBefore = bn(await committee[0].getBootstrapBalance());
        const c0FeesBefore = bn(await committee[0].getFeeBalance());

        expect(c0BootstrapBefore).to.be.bignumber.gt(bn(0));
        expect(c0FeesBefore).to.be.bignumber.gt(bn(0));

        let r = await d.feesAndBootstrapRewards.deactivateRewardDistribution({from: d.migrationManager.address});
        expect(r).to.have.a.rewardDistributionDeactivatedEvent();
        const deactivationTime = await d.web3.txTimestamp(r);

        const c0BootstrapAfter = bn(await committee[0].getBootstrapBalance());
        const c0FeesAfter = bn(await committee[0].getFeeBalance());

        expectApproxEq(c0BootstrapBefore, c0BootstrapAfter);
        expectApproxEq(c0FeesBefore, c0FeesAfter);

        await evmIncreaseTimeForQueries(d.web3, PERIOD);

        expect(await committee[0].getBootstrapBalance()).to.be.bignumber.eq(c0BootstrapAfter);
        expect(await committee[0].getFeeBalance()).to.be.bignumber.eq(c0FeesAfter);

        await evmIncreaseTimeForQueries(d.web3, PERIOD);

        expect(await committee[0].getBootstrapBalance()).to.be.bignumber.eq(c0BootstrapAfter);
        expect(await committee[0].getFeeBalance()).to.be.bignumber.eq(c0FeesAfter);

        r = await d.feesAndBootstrapRewards.activateRewardDistribution(deactivationTime, {from: d.migrationManager.address});
        expect(r).to.have.a.rewardDistributionActivatedEvent();

        expectApproxEq(await committee[0].getBootstrapBalance(), c0BootstrapAfter.mul(bn(3)));
        expectApproxEq(await committee[0].getFeeBalance(), c0FeesAfter.mul(bn(3)));
    });

    it("migrates guardian settings from previous contract", async () => {
        const d = await Driver.new();

        const guardians = _.range(4).map(() => d.newParticipant());
        const ratios = [bn(1000), bn(2000), bn(3000), bn(4000)];
        for (const [guardian, ratio] of _.zip(guardians, ratios)) {
            await d.stakingRewards.setGuardianDelegatorsStakingRewardsPercentMille(ratio, {from: (guardian as Participant).address});
        }

        const newRewardsContract = await d.web3.deploy('StakingRewards', [d.contractRegistry.address, d.registryAdmin.address, d.erc20.address,
            defaultDriverOptions.stakingRewardsAnnualRateInPercentMille,
            defaultDriverOptions.stakingRewardsAnnualCap,
            defaultDriverOptions.defaultDelegatorsStakingRewardsPercentMille,
            defaultDriverOptions.maxDelegatorsStakingRewardsPercentMille,
            d.stakingRewards.address,
            guardians.map(g => g.address)
        ], null, d.session);

        const creationTx = await newRewardsContract.getCreationTx();
        for (const [g, ratio] of _.zip(guardians, ratios)) {
            const guardian = g as Participant;
            expect(creationTx).to.have.a.guardianDelegatorsStakingRewardsPercentMilleUpdatedEvent({
                guardian: guardian.address,
                delegatorsStakingRewardsPercentMille: ratio
            });
            expect(await newRewardsContract.getGuardianDelegatorsStakingRewardsPercentMille(guardian.address)).to.bignumber.eq(ratio);
        }

    });

    it("full claim after deactivation, balance is 0 (staking rewards)", async () => {
        const {d, committee} = await fullCommittee();

        const PERIOD = MONTH_IN_SECONDS * 2;

        await evmIncreaseTimeForQueries(d.web3, PERIOD);

        await d.stakingRewards.deactivateRewardDistribution({from: d.migrationManager.address});
        await d.stakingRewardsWallet.setClient(ZERO_ADDR, {from: d.functionalManager.address});

        expect(await d.erc20.balanceOf(d.stakingRewards.address)).to.be.bignumber.gt(fromMilliOrbs(1) as any);
        expect(await d.stakingRewards.stakingRewardsContractBalance()).to.be.bignumber.eq(bn(await d.erc20.balanceOf(d.stakingRewards.address)));

        for (const c of committee) {
            await d.stakingRewards.claimStakingRewards(c.address);
        }

        expect(await d.erc20.balanceOf(d.stakingRewards.address)).to.be.bignumber.lt(bn(100));
        expect(await d.stakingRewards.stakingRewardsContractBalance()).to.be.bignumber.eq(bn(await d.erc20.balanceOf(d.stakingRewards.address)));
    });
});

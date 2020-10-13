
import BN from 'bn.js';
import {
    Driver,
    DEPLOYMENT_SUBSET_MAIN,
    Participant,
} from './driver';
import {MonthlySubscriptionPlanContract} from "../typings/monthly-subscription-plan-contract";
import {bn, fromMilliOrbs} from "./helpers";

export async function createVC(d : Driver, isCertified?: boolean, subscriber?: MonthlySubscriptionPlanContract, monthlyRate?: number|BN, appOwner?: Participant) {
    const rate: BN = monthlyRate != null ? bn(monthlyRate) : fromMilliOrbs(1000);
    const firstPayment = rate.mul(bn(20));

    subscriber = subscriber || await d.newSubscriber('defaultTier', rate);
    // buy subscription for a new VC
    appOwner =  appOwner || d.newParticipant();
    await d.erc20.assign(appOwner.address, firstPayment);
    await d.erc20.approve(subscriber.address, firstPayment, {
        from: appOwner.address
    });

    return subscriber.createVC("vc-name", firstPayment, isCertified || false, DEPLOYMENT_SUBSET_MAIN, {
        from: appOwner.address
    });
}

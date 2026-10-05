export type TxState =
  | 'awaiting_agreement'
  | 'agreed'
  | 'condition_documented'
  | 'awaiting_payment'
  | 'funded'
  | 'dispatched'
  | 'delivered'
  | 'inspected'
  | 'completed'
  | 'disputed'
  | 'resolved'
  | 'cancelled';

export type Actor = 'buyer' | 'seller' | 'system' | 'arbiter';

export interface Transition {
  from: TxState[];
  to: TxState;
  actors: Actor[];
}

/** The single source of truth for what may happen to a transaction, and who may do it. */
export const TRANSITIONS = {
  'spec.agreed': { from: ['awaiting_agreement'], to: 'agreed', actors: ['buyer'] },
  'condition.documented': { from: ['agreed'], to: 'condition_documented', actors: ['seller'] },
  'payment.checkout_started': { from: ['condition_documented', 'awaiting_payment'], to: 'awaiting_payment', actors: ['buyer'] },
  'payment.confirmed': { from: ['awaiting_payment'], to: 'funded', actors: ['system'] },
  'goods.dispatched': { from: ['funded'], to: 'dispatched', actors: ['seller'] },
  'delivery.confirmed': { from: ['dispatched'], to: 'delivered', actors: ['buyer'] },
  'inspection.submitted': { from: ['delivered'], to: 'inspected', actors: ['buyer'] },
  'buyer.approved': { from: ['inspected'], to: 'completed', actors: ['buyer'] },
  'dispute.opened': { from: ['dispatched', 'delivered', 'inspected'], to: 'disputed', actors: ['buyer'] },
  'dispute.resolved': { from: ['disputed'], to: 'resolved', actors: ['arbiter'] },
  'transaction.cancelled': {
    from: ['awaiting_agreement', 'agreed', 'condition_documented'],
    to: 'cancelled',
    actors: ['buyer', 'seller'],
  },
} as const satisfies Record<string, Transition>;

export type TransitionName = keyof typeof TRANSITIONS;

export type EvidencePhase = 'seller_condition' | 'dispatch' | 'delivery' | 'unboxing' | 'inspection' | 'dispute';

/** Which party may attach evidence for a phase, and in which transaction states. */
export const EVIDENCE_RULES: Record<EvidencePhase, { actors: Actor[]; states: TxState[] }> = {
  seller_condition: { actors: ['seller'], states: ['agreed'] },
  dispatch: { actors: ['seller'], states: ['funded'] },
  delivery: { actors: ['buyer'], states: ['dispatched', 'delivered'] },
  unboxing: { actors: ['buyer'], states: ['delivered'] },
  inspection: { actors: ['buyer'], states: ['delivered'] },
  dispute: { actors: ['buyer', 'seller'], states: ['disputed'] },
};

export const MONEY_HELD_STATES: TxState[] = ['funded', 'dispatched', 'delivered', 'inspected', 'disputed'];

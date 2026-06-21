# x402 extension (sketch): personhood-gated resources

**Status:** draft sketch for discussion — not yet an x402 PR.
**Author:** DrVelvetFog · **Depends on:** x402 `exact` scheme · **Composable with:** settlement-receipt binding ([#2666](https://github.com/x402-foundation/x402/pull/2666)).

## Abstract

A resource server can already require *payment* via x402. This extension lets it
*additionally* require **proof that a real, unique human stands behind the paying
agent** — verified on-chain, with no centralized gatekeeper. It standardizes the
"verified-resource gate": **paid AND personhood-proven**.

## Motivation

As autonomous agents become buyers, "charge per call" is necessary but not
sufficient. A paid endpoint is still trivially **sybil-farmed**: one operator
spins up thousands of agents, each paying dust, to scrape, drain rate-limited
quotas, claim per-identity rewards, or grief. Payment proves *funds*, not
*who is behind the request*.

Services selling to agents want a cheap, open way to say: *"one real human per
agent."* Today they reach for centralized KYC, captchas (which agents can't and
shouldn't solve), or API-key allowlists — all of which break the permissionless,
agent-native promise of x402.

## The extension

A resource advertises a personhood requirement in `accepts[].extra.personhood`:

```jsonc
// in the 402 challenge (PaymentRequirements.extra)
"personhood": {
  "scheme": "por",                 // proof-of-personhood scheme id
  "network": "sui:testnet",        // where the credential lives
  "minLevel": "DeviceHuman",       // assurance level required
  "unique": true                   // require a uniqueness proof (sybil-resistance)
}
```

**The proof is the payment itself.** The agent signs the x402 payment with a key
that holds a personhood credential. The resource derives the payer from the signed
payment (it does not trust a client-claimed identity) and verifies, *on-chain*,
that the payer holds a credential meeting `scheme`/`minLevel`/`unique`. No extra
challenge round-trip, and the economic act (paying) is cryptographically the same
key as the identity claim.

### Flow

```
1. agent → GET resource
2. resource → 402  { accepts:[{ ...terms, extra.personhood }] }
3. agent → GET resource  (PAYMENT-SIGNATURE: signed Sui payment from a
                          personhood-bearing key)
4. resource: payer := senderOf(payment)            # derived, not claimed
             verify personhood(payer) on-chain     # FIRST — before settling
             if !ok → 403 (agent never pays)
             settle payment via facilitator
             recompute settlement on-chain          # don't trust, recompute
             → 200 + data  (POR-VERIFIED: {level, unique})
```

Ordering matters: **personhood is checked before settlement**, so an un-verified
agent is rejected without being charged.

## Verification is trustless

Both gates are independently checkable, no operator trust required:
- **Payment** — recompute the net transfer to `payTo` from the settlement digest
  (the conformance-MCP / [#2666](https://github.com/x402-foundation/x402/pull/2666) pattern).
- **Personhood** — the credential and (for `unique:true`) the uniqueness proof are
  on-chain objects; anyone can verify the payer holds them. The first reference
  implementation (PoR on Sui) binds a Walrus/credential object's `agent_id` to a
  delegate key registered to the holder.

## Scope & honest caveats

- **Personhood ≠ authority.** This proves a unique human is *behind* the agent.
  It does **not** prove the agent is authorized to act for that human, nor is it
  KYB/KYC. Don't use it as an authorization or compliance primitive.
- **Assurance is a spectrum.** `DeviceHuman` (live human + device) is weaker than
  a uniqueness-backed level; `unique:true` is what delivers sybil-resistance. A
  resource should require the level its threat model needs.
- **Chain/scheme-agnostic.** `scheme:"por"` is the first; the field is open to
  other proof-of-personhood systems (World ID, zk-passport, …) on any chain.

## Relationship to other work

- **Settlement-receipt binding ([#2666](https://github.com/x402-foundation/x402/pull/2666))** —
  composable: a receipt can additionally bind the personhood proof, producing a
  signed, recomputable record of *who* (unique human) paid *what*.
- **Reference implementation** — `verified-agent` (this repo): PoR identity +
  x402 payment + Walrus memory + local inference, end-to-end on Sui testnet.

## Open questions

1. Credential **freshness/expiry** semantics in the challenge (max age?).
2. Should the resource state the **exact credential type/registry** it trusts, or
   a scheme id + discovery?
3. Privacy: the on-chain personhood check is public — does a resource leak which
   agents it serves? (mitigation: opaque/hashed subject metadata.)
4. A standard `POR-VERIFIED` / personhood response header shape.

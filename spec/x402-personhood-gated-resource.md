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

**The binding is two facts, checked separately.** A personhood claim about a party
is established by proving (A) that party controls address `X`, and (B) that `X`
holds a credential meeting `scheme`/`minLevel`/`unique`. Fact B is a plain on-chain
read — any third party can check it against public state without the holder
participating at verification time. Fact A is whatever proof of address control the
flow already produces. The extension never trusts a client-claimed identity; the
address is always *derived* from a signature.

**For the paying agent, the payment is the proof of control.** The agent signs the
x402 payment with a key that holds a credential; the resource derives the payer from
the signed payment and checks fact B against it. No extra challenge round-trip, and
the economic act is cryptographically the same key as the identity claim — the
payment does double duty.

That is a convenience of the payer case, not the mechanism. Where the party being
credentialed is not the one paying, fact A is supplied by an explicit signature
instead ([§Parties that do not pay](#parties-that-do-not-pay)). The credential check
is identical in both.

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

## Parties that do not pay

Some flows need a personhood claim about a party who never signs a payment — most
concretely, a **data subject** whose attribute is being disclosed and who consents
to that disclosure ([#2734](https://github.com/x402-foundation/x402/issues/2734)).
The payer is the reader; the subject is a different party, and no payment signature
exists to derive them from.

The same two facts apply, with fact A supplied explicitly:

- **(A) Control of address `X`** — the party signs the document that carries their
  decision (a consent grant, a mandate, an authorization) with the key for `X`,
  using an off-chain personal-message signature. No transaction, no gas, no
  on-chain footprint. The verifier recovers `X` from the signature; it is never
  claimed in a field.
- **(B) Credential at `X`** — verified exactly as in the payer case, against the
  same `scheme`/`minLevel`/`unique` shape, by the same public on-chain read.

A document verified this way carries the property *"signed by a credentialed unique
human"* — which is what makes a per-party payout resistant to fabricated parties.
Where a protocol settles value to subjects, creating subjects is otherwise free,
because keypairs are free; requiring fact B for the signing key makes it cost one
credentialed human per scope.

The personhood requirement for a non-paying party is advertised in the same
scheme-keyed shape as `extra.personhood`, so a composing extension states the
requirement abstractly and any conforming scheme (`por`, `worldid`, …) satisfies it.
This extension defines the requirement and its verification; it does not define the
document being signed, which belongs to the composing extension.

## Verification is trustless

Both gates are independently checkable, no operator trust required:
- **Payment** — recompute the net transfer to `payTo` from the settlement digest
  (the conformance-MCP / [#2666](https://github.com/x402-foundation/x402/pull/2666) pattern).
- **Personhood** — the credential and (for `unique:true`) the uniqueness proof are
  on-chain objects; anyone can verify the holder controls them, from public state
  and without the holder's cooperation. In the first reference implementation (PoR
  on Sui) the credential is a soulbound owned object, so "holds a credential" is
  ownership of that object by the derived address — there is no delegation step and
  no separate registered key.

## Scope & honest caveats

- **Personhood ≠ authority.** This proves a unique human is *behind* the agent.
  It does **not** prove the agent is authorized to act for that human, nor is it
  KYB/KYC. Don't use it as an authorization or compliance primitive.
- **Assurance is a spectrum.** `DeviceHuman` (live human + device) is weaker than
  a uniqueness-backed level; `unique:true` is what delivers sybil-resistance. A
  resource should require the level its threat model needs.
- **Uniqueness is correlatable — it is not a privacy primitive.** A uniqueness proof
  under `unique:true` is a public fact about a persistent identifier. In the first
  reference implementation the identifier is **one global nullifier per human per
  deployment**, stored in a public table and emitted in an event, so every resource
  that sees it sees the same value. Requiring `unique:true` is therefore a decision
  to make a party linkable across every verifier using that deployment. Do not treat
  a nullifier as a scope-local or per-application identifier unless the scheme in
  question actually derives one; the underlying circuit here admits a per-context
  nullifier, but the deployment pins a single context and rejects proofs for any
  other. Where a party only needs a stable key for their own audit trail, the
  address they already signed with is the weaker and better choice.
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
3. Privacy: the on-chain personhood check is public, and under `unique:true` the
   nullifier is a cross-verifier correlator (§Scope & honest caveats). Hashing
   resource-side metadata does not address this, because the correlatable value
   originates on-chain. The real options are scheme-level: per-scope nullifier
   derivation, or a predicate proof that shows "holds ≥ L, is unique" without
   revealing a persistent identifier. Neither exists in the first reference
   implementation today.
4. A standard `POR-VERIFIED` / personhood response header shape.

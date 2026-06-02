/**
 * SDK integration tests against Stellar testnet — issue #233.
 *
 * These tests exercise real XDR encoding and actual contract interactions
 * on the Stellar testnet. They are intentionally excluded from the normal
 * `pnpm test` run and only execute when three funded keypair secrets are
 * provided as environment variables:
 *
 *   FREELANCER_SECRET   — signs submit_invoice / get_invoice calls
 *   PAYER_SECRET        — signs mark_paid calls
 *   FUNDER_SECRET       — signs fund_invoice / claim_default calls
 *
 * The suite first performs a Horizon health check. If the testnet is
 * unreachable, all tests are skipped gracefully rather than failing CI.
 *
 * Run locally:
 *   FREELANCER_SECRET=S… PAYER_SECRET=S… FUNDER_SECRET=S… \
 *     pnpm test:integration-testnet
 */

import { describe, it, expect, beforeAll } from "vitest";
import { Networks, rpc as StellarRpc } from "@stellar/stellar-sdk";
import { ILNSdk } from "../../src/client";
import { ILN_TESTNET, createKeypairSigner } from "../../src/signers";

// ── Constants ────────────────────────────────────────────────────────────────

const INVOICE_AMOUNT = 10_000_000n;   // 1 XLM in stroops
const DISCOUNT_RATE  = 300;           // 3 % in basis points
const TX_TIMEOUT_MS  = 120_000;       // 2 min per transaction test
const DUE_DATE_OFFSET = 300;          // 5 min from now

const HORIZON_HEALTH_URL = "https://horizon-testnet.stellar.org/";

// ── Skip guard ───────────────────────────────────────────────────────────────

const FREELANCER_SECRET = process.env.FREELANCER_SECRET;
const PAYER_SECRET      = process.env.PAYER_SECRET;
const FUNDER_SECRET     = process.env.FUNDER_SECRET;

const hasSecrets = Boolean(FREELANCER_SECRET && PAYER_SECRET && FUNDER_SECRET);

/** True when the Stellar testnet Horizon is reachable. Determined in beforeAll. */
let testnetReachable = false;

async function checkHorizonHealth(): Promise<boolean> {
  try {
    const res = await fetch(HORIZON_HEALTH_URL, { signal: AbortSignal.timeout(5_000) });
    return res.ok;
  } catch {
    return false;
  }
}

// ── Suite ────────────────────────────────────────────────────────────────────

describe("SDK testnet integration (#233)", () => {
  beforeAll(async () => {
    testnetReachable = await checkHorizonHealth();
    if (!testnetReachable) {
      console.warn(
        "[integration] Stellar testnet unreachable — all tests will be skipped.",
      );
    }
    if (!hasSecrets) {
      console.warn(
        "[integration] FREELANCER_SECRET / PAYER_SECRET / FUNDER_SECRET not set — all tests will be skipped.",
      );
    }
  });

  const skip = () => !hasSecrets || !testnetReachable;

  // Lazy SDK clients — only constructed when secrets are present.
  function makeSdks() {
    const freelancerSigner = createKeypairSigner(FREELANCER_SECRET!);
    const payerSigner      = createKeypairSigner(PAYER_SECRET!);
    const funderSigner     = createKeypairSigner(FUNDER_SECRET!);

    return {
      freelancerSdk: new ILNSdk({ ...ILN_TESTNET, signer: freelancerSigner }),
      payerSdk:      new ILNSdk({ ...ILN_TESTNET, signer: payerSigner }),
      funderSdk:     new ILNSdk({ ...ILN_TESTNET, signer: funderSigner }),
      freelancerSigner,
      payerSigner,
      funderSigner,
    };
  }

  // ── 1. Horizon health check ──────────────────────────────────────────────

  it("Horizon health endpoint responds OK", async () => {
    if (skip()) return;

    const healthy = await checkHorizonHealth();
    expect(healthy).toBe(true);
  });

  // ── 2. submit_invoice ────────────────────────────────────────────────────

  it("submits an invoice and returns a numeric invoice ID", async () => {
    if (skip()) return;

    const { freelancerSdk, freelancerSigner, payerSigner } = makeSdks();
    const freelancer = await freelancerSigner.getPublicKey();
    const payer      = await payerSigner.getPublicKey();
    const dueDate    = Math.floor(Date.now() / 1000) + DUE_DATE_OFFSET;

    const invoiceId = await freelancerSdk.submitInvoice({
      freelancer,
      payer,
      amount: INVOICE_AMOUNT,
      dueDate,
      discountRate: DISCOUNT_RATE,
    });

    expect(typeof invoiceId).toBe("bigint");
    expect(invoiceId).toBeGreaterThan(0n);
  }, TX_TIMEOUT_MS);

  // ── 3. get_invoice ───────────────────────────────────────────────────────

  it("retrieves a submitted invoice with Pending status", async () => {
    if (skip()) return;

    const { freelancerSdk, freelancerSigner, payerSigner } = makeSdks();
    const freelancer = await freelancerSigner.getPublicKey();
    const payer      = await payerSigner.getPublicKey();
    const dueDate    = Math.floor(Date.now() / 1000) + DUE_DATE_OFFSET;

    const invoiceId = await freelancerSdk.submitInvoice({
      freelancer,
      payer,
      amount: INVOICE_AMOUNT,
      dueDate,
      discountRate: DISCOUNT_RATE,
    });

    const invoice = await freelancerSdk.getInvoice(invoiceId);

    expect(invoice.id).toBe(invoiceId);
    expect(invoice.freelancer).toBe(freelancer);
    expect(invoice.payer).toBe(payer);
    expect(invoice.amount).toBe(INVOICE_AMOUNT);
    expect(invoice.status).toBe("Pending");
    expect(invoice.funder).toBeNull();
  }, TX_TIMEOUT_MS);

  // ── 4. fund_invoice ──────────────────────────────────────────────────────

  it("funds a pending invoice and transitions it to Funded", async () => {
    if (skip()) return;

    const { freelancerSdk, funderSdk, freelancerSigner, payerSigner, funderSigner } = makeSdks();
    const freelancer = await freelancerSigner.getPublicKey();
    const payer      = await payerSigner.getPublicKey();
    const funder     = await funderSigner.getPublicKey();
    const dueDate    = Math.floor(Date.now() / 1000) + DUE_DATE_OFFSET;

    const invoiceId = await freelancerSdk.submitInvoice({
      freelancer,
      payer,
      amount: INVOICE_AMOUNT,
      dueDate,
      discountRate: DISCOUNT_RATE,
    });

    await funderSdk.fundInvoice({ funder, invoiceId });

    const invoice = await freelancerSdk.getInvoice(invoiceId);
    expect(invoice.status).toBe("Funded");
    expect(invoice.funder).toBe(funder);
    expect(invoice.fundedAt).not.toBeNull();
  }, TX_TIMEOUT_MS);

  // ── 5. mark_paid ─────────────────────────────────────────────────────────

  it("marks a funded invoice as paid and confirms Paid status", async () => {
    if (skip()) return;

    const { freelancerSdk, payerSdk, funderSdk, freelancerSigner, payerSigner, funderSigner } = makeSdks();
    const freelancer = await freelancerSigner.getPublicKey();
    const payer      = await payerSigner.getPublicKey();
    const funder     = await funderSigner.getPublicKey();
    const dueDate    = Math.floor(Date.now() / 1000) + DUE_DATE_OFFSET;

    const invoiceId = await freelancerSdk.submitInvoice({
      freelancer,
      payer,
      amount: INVOICE_AMOUNT,
      dueDate,
      discountRate: DISCOUNT_RATE,
    });
    await funderSdk.fundInvoice({ funder, invoiceId });
    await payerSdk.markPaid({ invoiceId });

    const invoice = await freelancerSdk.getInvoice(invoiceId);
    expect(invoice.status).toBe("Paid");
  }, TX_TIMEOUT_MS);

  // ── 6. get_contract_stats ────────────────────────────────────────────────

  it("get_contract_stats returns non-negative numeric counters", async () => {
    if (skip()) return;

    const { freelancerSdk } = makeSdks();
    const stats = await freelancerSdk.getStats();

    expect(typeof stats.totalInvoices).toBe("number");
    expect(typeof stats.totalFunded).toBe("number");
    expect(typeof stats.totalPaid).toBe("number");
    expect(stats.totalInvoices).toBeGreaterThanOrEqual(0);
    expect(stats.totalFunded).toBeGreaterThanOrEqual(0);
    expect(stats.totalPaid).toBeGreaterThanOrEqual(0);
  }, TX_TIMEOUT_MS);

  it("get_contract_stats increments after a full submit→fund→paid cycle", async () => {
    if (skip()) return;

    const { freelancerSdk, payerSdk, funderSdk, freelancerSigner, payerSigner, funderSigner } = makeSdks();
    const freelancer = await freelancerSigner.getPublicKey();
    const payer      = await payerSigner.getPublicKey();
    const funder     = await funderSigner.getPublicKey();
    const dueDate    = Math.floor(Date.now() / 1000) + DUE_DATE_OFFSET;

    const before = await freelancerSdk.getStats();

    const invoiceId = await freelancerSdk.submitInvoice({
      freelancer,
      payer,
      amount: INVOICE_AMOUNT,
      dueDate,
      discountRate: DISCOUNT_RATE,
    });
    await funderSdk.fundInvoice({ funder, invoiceId });
    await payerSdk.markPaid({ invoiceId });

    const after = await freelancerSdk.getStats();

    expect(after.totalInvoices).toBeGreaterThan(before.totalInvoices);
    expect(after.totalFunded).toBeGreaterThan(before.totalFunded);
    expect(after.totalPaid).toBeGreaterThan(before.totalPaid);
  }, TX_TIMEOUT_MS * 2);

  // ── 7. get_reputation ────────────────────────────────────────────────────

  it("get_reputation returns a profile with numeric scores for any address", async () => {
    if (skip()) return;

    const { freelancerSdk, freelancerSigner } = makeSdks();
    const freelancer = await freelancerSigner.getPublicKey();

    const profile = await freelancerSdk.getReputation(freelancer);

    expect(typeof profile.payerScore).toBe("number");
    expect(typeof profile.lpScore).toBe("number");
    expect(profile.payerScore).toBeGreaterThanOrEqual(0);
    expect(profile.lpScore).toBeGreaterThanOrEqual(0);
  }, TX_TIMEOUT_MS);

  it("funder reputation score increases after funding an invoice", async () => {
    if (skip()) return;

    const { freelancerSdk, funderSdk, freelancerSigner, payerSigner, funderSigner } = makeSdks();
    const freelancer = await freelancerSigner.getPublicKey();
    const payer      = await payerSigner.getPublicKey();
    const funder     = await funderSigner.getPublicKey();
    const dueDate    = Math.floor(Date.now() / 1000) + DUE_DATE_OFFSET;

    const before = await freelancerSdk.getReputation(funder);

    const invoiceId = await freelancerSdk.submitInvoice({
      freelancer,
      payer,
      amount: INVOICE_AMOUNT,
      dueDate,
      discountRate: DISCOUNT_RATE,
    });
    await funderSdk.fundInvoice({ funder, invoiceId });

    const after = await freelancerSdk.getReputation(funder);
    expect(after.lpScore).toBeGreaterThan(before.lpScore);
  }, TX_TIMEOUT_MS);
});

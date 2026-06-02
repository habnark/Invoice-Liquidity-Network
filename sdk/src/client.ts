import {
  Account,
  Address,
  BASE_FEE,
  Operation,
  TransactionBuilder,
  rpc,
  scValToNative,
  nativeToScVal,
  xdr,
} from "@stellar/stellar-sdk";

import type {
  ClaimDefaultParams,
  ContractStats,
  FundInvoiceParams,
  ILNSdkConfig,
  Invoice,
  InvoiceStatus,
  MarkPaidParams,
  ReputationProfile,
  RpcServerLike,
  SubmitInvoiceParams,
  TransactionSigner,
} from "./types";

const READ_ACCOUNT = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const POLL_ATTEMPTS = 20;

type PreparedTransactionLike = { toXDR(): string };
type BuiltTransaction = ReturnType<TransactionBuilder["build"]>;
type SimulationLike = {
  error?: unknown;
  result?: {
    retval?: xdr.ScVal;
  };
};

export class ILNSdk {
  private readonly contractId: string;
  private readonly networkPassphrase: string;
  private readonly server: RpcServerLike;
  private readonly signer?: TransactionSigner;

  constructor(config: ILNSdkConfig) {
    this.contractId = config.contractId;
    this.networkPassphrase = config.networkPassphrase;
    this.server = config.server ?? new rpc.Server(config.rpcUrl);
    this.signer = config.signer;
  }

  async submitInvoice(params: SubmitInvoiceParams): Promise<bigint> {
    const signerAddress = await this.requireSignerAddress();

    if (signerAddress !== params.freelancer) {
      throw new Error("submitInvoice must be signed by the freelancer address.");
    }

    const transaction = await this.buildWriteTransaction(params.freelancer, "submit_invoice", [
      this.toAddress(params.freelancer),
      this.toAddress(params.payer),
      nativeToScVal(params.amount, { type: "i128" }),
      nativeToScVal(params.dueDate, { type: "u64" }),
      nativeToScVal(params.discountRate, { type: "u32" }),
    ]);

    const simulation = await this.server.simulateTransaction(transaction);
    const invoiceId = this.extractBigIntResult(simulation, "submit_invoice");
    const preparedTransaction = await this.prepareTransaction(transaction);

    await this.signAndSend(preparedTransaction, params.freelancer);
    return invoiceId;
  }

  async fundInvoice(params: FundInvoiceParams): Promise<void> {
    const signerAddress = await this.requireSignerAddress();

    if (signerAddress !== params.funder) {
      throw new Error("fundInvoice must be signed by the funder address.");
    }

    const transaction = await this.buildWriteTransaction(params.funder, "fund_invoice", [
      this.toAddress(params.funder),
      nativeToScVal(params.invoiceId, { type: "u64" }),
    ]);

    const preparedTransaction = await this.prepareTransaction(transaction);
    await this.signAndSend(preparedTransaction, params.funder);
  }

  async markPaid(params: MarkPaidParams): Promise<void> {
    const payer = await this.requireSignerAddress();
    const transaction = await this.buildWriteTransaction(payer, "mark_paid", [
      nativeToScVal(params.invoiceId, { type: "u64" }),
    ]);
    const preparedTransaction = await this.prepareTransaction(transaction);

    await this.signAndSend(preparedTransaction, payer);
  }

  async claimDefault(params: ClaimDefaultParams): Promise<void> {
    const signerAddress = await this.requireSignerAddress();

    if (signerAddress !== params.funder) {
      throw new Error("claimDefault must be signed by the funder address.");
    }

    const transaction = await this.buildWriteTransaction(params.funder, "claim_default", [
      this.toAddress(params.funder),
      nativeToScVal(params.invoiceId, { type: "u64" }),
    ]);
    const preparedTransaction = await this.prepareTransaction(transaction);

    await this.signAndSend(preparedTransaction, params.funder);
  }

  async getStats(): Promise<ContractStats> {
    const transaction = this.buildReadTransaction("get_contract_stats", []);
    const simulation = await this.server.simulateTransaction(transaction);
    return this.extractStatsResult(simulation);
  }

  async getReputation(address: string): Promise<ReputationProfile> {
    const transaction = this.buildReadTransaction("get_reputation", [
      this.toAddress(address),
    ]);
    const simulation = await this.server.simulateTransaction(transaction);
    return this.extractReputationResult(simulation);
  }

  async getInvoice(invoiceId: bigint): Promise<Invoice> {
    const transaction = this.buildReadTransaction("get_invoice", [
      nativeToScVal(invoiceId, { type: "u64" }),
    ]);
    const simulation = await this.server.simulateTransaction(transaction);

    return this.extractInvoiceResult(simulation);
  }

  private buildReadTransaction(method: string, args: xdr.ScVal[]): BuiltTransaction {
    return new TransactionBuilder(new Account(READ_ACCOUNT, "0"), {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        Operation.invokeContractFunction({
          contract: this.contractId,
          function: method,
          args,
        }),
      )
      .setTimeout(30)
      .build();
  }

  private async buildWriteTransaction(
    sourceAddress: string,
    method: string,
    args: xdr.ScVal[],
  ): Promise<BuiltTransaction> {
    const sourceAccount = (await this.server.getAccount(sourceAddress)) as Account;

    return new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        Operation.invokeContractFunction({
          contract: this.contractId,
          function: method,
          args,
        }),
      )
      .setTimeout(30)
      .build();
  }

  private async requireSignerAddress(): Promise<string> {
    if (!this.signer) {
      throw new Error("A transaction signer is required for state-changing contract calls.");
    }

    return this.signer.getPublicKey();
  }

  private async prepareTransaction(
    transaction: BuiltTransaction,
  ): Promise<PreparedTransactionLike> {
    try {
      return await this.server.prepareTransaction(transaction);
    } catch (error) {
      throw new Error(`Failed to prepare contract transaction: ${this.toErrorMessage(error)}`);
    }
  }

  private async signAndSend(
    preparedTransaction: PreparedTransactionLike,
    sourceAddress: string,
  ): Promise<void> {
    const signer = this.signer;
    if (!signer) {
      throw new Error("A transaction signer is required for state-changing contract calls.");
    }

    const signedXdr = await signer.signTransaction(preparedTransaction.toXDR(), {
      address: sourceAddress,
      networkPassphrase: this.networkPassphrase,
    });
    const signedTransaction = TransactionBuilder.fromXDR(
      signedXdr,
      this.networkPassphrase,
    );
    const response = (await this.server.sendTransaction(signedTransaction)) as {
      errorResultXdr?: string;
      hash?: string;
      status?: string;
    };

    if (!response.hash || !response.status) {
      throw new Error("RPC server returned an invalid sendTransaction response.");
    }

    if (response.status !== "PENDING" && response.status !== "DUPLICATE") {
      throw new Error(
        `Transaction submission failed with status ${response.status}. ${response.errorResultXdr ?? ""}`.trim(),
      );
    }

    const finalStatus = (await this.server.pollTransaction(response.hash, {
      attempts: POLL_ATTEMPTS,
    })) as {
      resultXdr?: string;
      status?: string;
    };

    if (finalStatus.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
      throw new Error(
        `Transaction did not succeed. Final status: ${String(finalStatus.status)}.`,
      );
    }
  }

  private extractBigIntResult(simulation: unknown, method: string): bigint {
    const result = this.extractSimulationRetval(simulation, method);
    return this.toBigInt(this.unwrapContractResult(scValToNative(result), method));
  }

  private extractInvoiceResult(simulation: unknown): Invoice {
    const result = this.extractSimulationRetval(simulation, "get_invoice");
    const nativeInvoice = this.unwrapContractResult(
      scValToNative(result),
      "get_invoice",
    ) as Record<string, unknown>;

    return {
      id: this.toBigInt(nativeInvoice.id),
      freelancer: this.toStringValue(nativeInvoice.freelancer, "freelancer"),
      payer: this.toStringValue(nativeInvoice.payer, "payer"),
      amount: this.toBigInt(nativeInvoice.amount),
      dueDate: this.toNumberValue(
        nativeInvoice.due_date ?? nativeInvoice.dueDate,
        "dueDate",
      ),
      discountRate: this.toNumberValue(
        nativeInvoice.discount_rate ?? nativeInvoice.discountRate,
        "discountRate",
      ),
      status: this.parseStatus(nativeInvoice.status),
      funder: nativeInvoice.funder == null ? null : this.toStringValue(nativeInvoice.funder, "funder"),
      fundedAt:
        nativeInvoice.funded_at == null && nativeInvoice.fundedAt == null
          ? null
          : this.toNumberValue(nativeInvoice.funded_at ?? nativeInvoice.fundedAt, "fundedAt"),
    };
  }

  private extractStatsResult(simulation: unknown): ContractStats {
    const result = this.extractSimulationRetval(simulation, "get_contract_stats");
    const raw = this.unwrapContractResult(
      scValToNative(result),
      "get_contract_stats",
    ) as Record<string, unknown>;
    return {
      totalInvoices: this.toNumberValue(
        raw.total_invoices ?? raw.totalInvoices ?? 0,
        "totalInvoices",
      ),
      totalFunded: this.toNumberValue(
        raw.total_funded ?? raw.totalFunded ?? 0,
        "totalFunded",
      ),
      totalPaid: this.toNumberValue(
        raw.total_paid ?? raw.totalPaid ?? 0,
        "totalPaid",
      ),
    };
  }

  private extractReputationResult(simulation: unknown): ReputationProfile {
    const result = this.extractSimulationRetval(simulation, "get_reputation");
    const raw = this.unwrapContractResult(
      scValToNative(result),
      "get_reputation",
    ) as Record<string, unknown>;
    return {
      payerScore: this.toNumberValue(
        raw.payer_score ?? raw.payerScore ?? 0,
        "payerScore",
      ),
      lpScore: this.toNumberValue(
        raw.lp_score ?? raw.lpScore ?? 0,
        "lpScore",
      ),
    };
  }

  private extractSimulationRetval(simulation: unknown, method: string): xdr.ScVal {
    const typedSimulation = simulation as SimulationLike;

    if (typedSimulation.error) {
      const error = typedSimulation.error;
      throw new Error(
        `Simulation failed for ${method}: ${error ? String(error) : "Unknown RPC error."}`,
      );
    }

    if (!typedSimulation.result?.retval) {
      throw new Error(`Simulation for ${method} did not return a contract result.`);
    }

    return typedSimulation.result.retval;
  }

  private unwrapContractResult(value: unknown, method: string): unknown {
    if (!value || typeof value !== "object") {
      return value;
    }

    if ("ok" in value) {
      return (value as { ok: unknown }).ok;
    }
    if ("Ok" in value) {
      return (value as { Ok: unknown }).Ok;
    }
    if ("err" in value) {
      throw new Error(
        `Contract method ${method} returned an error: ${JSON.stringify((value as { err: unknown }).err)}.`,
      );
    }
    if ("Err" in value) {
      throw new Error(
        `Contract method ${method} returned an error: ${JSON.stringify((value as { Err: unknown }).Err)}.`,
      );
    }

    return value;
  }

  private toAddress(address: string) {
    return Address.fromString(address).toScVal();
  }

  private toBigInt(value: unknown): bigint {
    if (typeof value === "bigint") {
      return value;
    }
    if (typeof value === "number") {
      return BigInt(value);
    }
    if (typeof value === "string") {
      return BigInt(value);
    }

    throw new Error(`Expected bigint-compatible value but received ${typeof value}.`);
  }

  private toNumberValue(value: unknown, field: string): number {
    if (typeof value === "number") {
      return value;
    }
    if (typeof value === "bigint") {
      return Number(value);
    }

    throw new Error(`Expected numeric ${field} value but received ${typeof value}.`);
  }

  private toStringValue(value: unknown, field: string): string {
    if (typeof value === "string") {
      return value;
    }

    throw new Error(`Expected string ${field} value but received ${typeof value}.`);
  }

  private parseStatus(value: unknown): InvoiceStatus {
    if (typeof value === "string") {
      return this.normalizeStatus(value);
    }

    if (value && typeof value === "object") {
      const [key] = Object.keys(value as Record<string, unknown>);
      if (key) {
        return this.normalizeStatus(key);
      }
    }

    throw new Error("Unable to parse invoice status from contract response.");
  }

  private normalizeStatus(value: string): InvoiceStatus {
    const normalized = value.slice(0, 1).toUpperCase() + value.slice(1).toLowerCase();

    switch (normalized) {
      case "Pending":
      case "Funded":
      case "Paid":
      case "Defaulted":
        return normalized;
      default:
        throw new Error(`Unknown invoice status "${value}".`);
    }
  }

  private toErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    return String(error);
  }
}

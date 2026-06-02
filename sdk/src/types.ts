export type InvoiceStatus = "Pending" | "Funded" | "Paid" | "Defaulted";

export interface Invoice {
  id: bigint;
  freelancer: string;
  payer: string;
  amount: bigint;
  dueDate: number;
  discountRate: number;
  status: InvoiceStatus;
  funder: string | null;
  fundedAt: number | null;
}

export interface SubmitInvoiceParams {
  freelancer: string;
  payer: string;
  amount: bigint;
  dueDate: number;
  discountRate: number;
}

export interface FundInvoiceParams {
  funder: string;
  invoiceId: bigint;
}

export interface ClaimDefaultParams {
  funder: string;
  invoiceId: bigint;
}

export interface MarkPaidParams {
  invoiceId: bigint;
}

export interface SignTransactionOptions {
  address?: string;
  networkPassphrase: string;
}

export interface TransactionSigner {
  getPublicKey(): Promise<string>;
  signTransaction(
    transactionXdr: string,
    options: SignTransactionOptions,
  ): Promise<string>;
}

export interface RpcServerLike {
  getAccount(address: string): Promise<unknown>;
  simulateTransaction(transaction: unknown): Promise<unknown>;
  prepareTransaction(transaction: unknown): Promise<{ toXDR(): string }>;
  sendTransaction(transaction: unknown): Promise<unknown>;
  pollTransaction(hash: string, options?: { attempts?: number }): Promise<unknown>;
}

export interface ILNSdkConfig {
  contractId: string;
  rpcUrl: string;
  networkPassphrase: string;
  signer?: TransactionSigner;
  server?: RpcServerLike;
}

export interface NetworkConfig {
  contractId: string;
  rpcUrl: string;
  networkPassphrase: string;
}

export interface ContractStats {
  totalInvoices: number;
  totalFunded: number;
  totalPaid: number;
}

export interface ReputationProfile {
  payerScore: number;
  lpScore: number;
}

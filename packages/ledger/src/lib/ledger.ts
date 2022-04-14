import { transactions as nearTransactions, utils } from "near-api-js";
import { TypedError } from "near-api-js/lib/utils/errors";
import isMobile from "is-mobile";
import {
  HardwareWallet,
  WalletModule,
  transformActions,
  Transaction,
} from "@near-wallet-selector/core";

import { LedgerClient, Subscription } from "./ledger-client";

interface AuthData {
  accountId: string;
  derivationPath: string;
  publicKey: string;
}

interface ValidateParams {
  accountId: string;
  publicKey: string;
}

interface GetAccountIdFromPublicKeyParams {
  publicKey: string;
}

interface LedgerState {
  authData: AuthData | null;
}

export interface LedgerParams {
  iconUrl?: string;
}

export const LOCAL_STORAGE_AUTH_DATA = `ledger:authData`;

export function setupLedger({
  iconUrl,
}: LedgerParams = {}): WalletModule<HardwareWallet> {
  return function Ledger({
    provider,
    network,
    emitter,
    logger,
    storage,
    updateState,
  }) {
    let client: LedgerClient | null;
    const subscriptions: Record<string, Subscription> = {};
    const state: LedgerState = { authData: null };

    const debugMode = false;

    const getAccounts = () => {
      const accountId = state.authData?.accountId;

      if (!accountId) {
        return [];
      }

      return [{ accountId }];
    };

    const signOut = async () => {
      for (const key in subscriptions) {
        subscriptions[key].remove();
      }

      storage.removeItem(LOCAL_STORAGE_AUTH_DATA);

      // Only close if we've already connected.
      if (client) {
        await client.disconnect();
      }

      updateState((prevState) => ({
        ...prevState,
        selectedWalletId: null,
      }));

      state.authData = null;
      client = null;

      const accounts = getAccounts();
      emitter.emit("accountsChanged", { accounts });
      emitter.emit("signOut", { accounts });
    };

    const getClient = async () => {
      if (client) {
        return client;
      }
      const ledgerClient = new LedgerClient();

      await ledgerClient.connect();
      ledgerClient.setScrambleKey("NEAR");

      subscriptions["disconnect"] = ledgerClient.on("disconnect", (err) => {
        logger.error(err);

        signOut();
      });

      if (debugMode) {
        subscriptions["logs"] = ledgerClient.listen((data) => {
          logger.log("Ledger:init:logs", data);
        });
      }

      client = ledgerClient;

      return ledgerClient;
    };

    const validate = async ({ accountId, publicKey }: ValidateParams) => {
      logger.log("Ledger:validate", { accountId, publicKey });

      logger.log("Ledger:validate:publicKey", { publicKey });

      try {
        const accessKey = await provider.viewAccessKey({
          accountId,
          publicKey,
        });

        logger.log("Ledger:validate:accessKey", { accessKey });

        if (accessKey.permission !== "FullAccess") {
          throw new Error("Public key requires 'FullAccess' permission");
        }

        return {
          publicKey,
          accessKey,
        };
      } catch (err) {
        if (err instanceof TypedError && err.type === "AccessKeyDoesNotExist") {
          return {
            publicKey,
            accessKey: null,
          };
        }

        throw err;
      }
    };

    const getAccountIdFromPublicKey = async ({
      publicKey,
    }: GetAccountIdFromPublicKeyParams): Promise<string> => {
      const response = await fetch(
        `${network.helperUrl}/publicKey/ed25519:${publicKey}/accounts`
      );

      const accountIds = await response.json();

      if (accountIds.error) {
        throw new Error(accountIds.error);
      }

      if (Array.isArray(accountIds) && accountIds.length === 0) {
        throw new Error("No account found");
      }

      const accountId = accountIds[0];

      return accountId;
    };

    const signTransaction = async (
      transaction: nearTransactions.Transaction,
      ledgerClient: LedgerClient,
      derivationPath: string
    ) => {
      const serializedTx = utils.serialize.serialize(
        nearTransactions.SCHEMA,
        transaction
      );

      const signature = await ledgerClient.sign({
        data: serializedTx,
        derivationPath,
      });

      return new nearTransactions.SignedTransaction({
        transaction,
        signature: new nearTransactions.Signature({
          keyType: transaction.publicKey.keyType,
          data: signature,
        }),
      });
    };

    const signTransactions = async (transactions: Array<Transaction>) => {
      if (!state.authData) {
        throw new Error("Not signed in");
      }

      const { accountId, derivationPath, publicKey } = state.authData;
      const ledgerClient = await getClient();

      const [block, accessKey] = await Promise.all([
        provider.block({ finality: "final" }),
        provider.viewAccessKey({ accountId, publicKey }),
      ]);

      const signedTransactions: Array<nearTransactions.SignedTransaction> = [];

      for (let i = 0; i < transactions.length; i++) {
        const actions = transformActions(transactions[i].actions);

        const transaction = nearTransactions.createTransaction(
          accountId,
          utils.PublicKey.from(publicKey),
          transactions[i].receiverId,
          accessKey.nonce + i + 1,
          actions,
          utils.serialize.base_decode(block.header.hash)
        );

        const signedTx = await signTransaction(
          transaction,
          ledgerClient,
          derivationPath
        );
        signedTransactions.push(signedTx);
      }
      return signedTransactions;
    };

    return {
      id: "ledger",
      type: "hardware",
      name: "Ledger",
      description: null,
      iconUrl: iconUrl || "./assets/ledger-icon.png",

      isAvailable() {
        if (!LedgerClient.isSupported()) {
          return false;
        }

        if (isMobile()) {
          return false;
        }

        return true;
      },

      async init() {
        state.authData = storage.getItem<AuthData>(LOCAL_STORAGE_AUTH_DATA);
      },
      async signIn({ derivationPath }) {
        if (await this.isSignedIn()) {
          return;
        }

        if (!derivationPath) {
          throw new Error("Invalid derivation path");
        }

        const ledgerClient = await getClient();

        const publicKey = await ledgerClient.getPublicKey({
          derivationPath: derivationPath,
        });

        const accountId = await getAccountIdFromPublicKey({ publicKey });

        const { accessKey } = await validate({
          accountId,
          publicKey,
        });

        if (!accessKey) {
          throw new Error(
            `Public key is not registered with the account '${accountId}'.`
          );
        }

        const authData: AuthData = {
          accountId,
          derivationPath,
          publicKey,
        };

        storage.setItem(LOCAL_STORAGE_AUTH_DATA, authData);

        state.authData = authData;

        updateState((prevState) => ({
          ...prevState,
          showModal: false,
          selectedWalletId: this.id,
        }));

        const accounts = getAccounts();
        emitter.emit("signIn", { accounts });
        emitter.emit("accountsChanged", { accounts });
      },

      signOut,

      async isSignedIn() {
        return !!state.authData;
      },

      async getAccounts() {
        return getAccounts();
      },

      async signAndSendTransaction({ signerId, receiverId, actions }) {
        logger.log("Ledger:signAndSendTransaction", {
          signerId,
          receiverId,
          actions,
        });

        if (!state.authData) {
          throw new Error("Not signed in");
        }

        const { accountId, derivationPath, publicKey } = state.authData;
        const ledgerClient = await getClient();

        const [block, accessKey] = await Promise.all([
          provider.block({ finality: "final" }),
          provider.viewAccessKey({ accountId, publicKey }),
        ]);

        logger.log("Ledger:signAndSendTransaction:block", block);
        logger.log("Ledger:signAndSendTransaction:accessKey", accessKey);

        const transaction = nearTransactions.createTransaction(
          accountId,
          utils.PublicKey.from(publicKey),
          receiverId,
          accessKey.nonce + 1,
          transformActions(actions),
          utils.serialize.base_decode(block.header.hash)
        );

        const signedTx = await signTransaction(
          transaction,
          ledgerClient,
          derivationPath
        );

        return provider.sendTransaction(signedTx);
      },

      async signAndSendTransactions({ transactions }) {
        const signedTransactions = await signTransactions(transactions);

        return Promise.all(
          signedTransactions.map((signedTx) =>
            provider.sendTransaction(signedTx)
          )
        );
      },
    };
  };
}

import {
  BufferJSON,
  initAuthCreds,
  proto,
  type AuthenticationState,
  type SignalDataSet,
  type SignalDataTypeMap
} from "@whiskeysockets/baileys";
import { Repository } from "../db/repository.js";
import { EncryptionService } from "../security/encryption.js";

export async function createEncryptedAuthState(
  accountId: string,
  repository: Repository,
  encryption: EncryptionService
): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }> {
  const read = async <T>(type: string, id: string): Promise<T | null> => {
    const encrypted = await repository.getSessionValue(accountId, type, id);
    if (!encrypted) return null;
    return JSON.parse(encryption.decrypt(encrypted), BufferJSON.reviver) as T;
  };
  const write = async (type: string, id: string, value: unknown): Promise<void> => {
    const serialized = JSON.stringify(value, BufferJSON.replacer);
    await repository.setSessionValue(accountId, type, id, encryption.encrypt(serialized));
  };

  const creds = (await read<AuthenticationState["creds"]>("creds", "main")) ?? initAuthCreds();
  const state: AuthenticationState = {
    creds,
    keys: {
      get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
        const values: { [id: string]: SignalDataTypeMap[T] } = {};
        await Promise.all(
          ids.map(async (id) => {
            let value = await read<SignalDataTypeMap[T]>(type, id);
            if (type === "app-state-sync-key" && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(
                value as unknown as Record<string, unknown>
              ) as unknown as SignalDataTypeMap[T];
            }
            if (value) values[id] = value;
          })
        );
        return values;
      },
      set: async (data: SignalDataSet) => {
        const operations: Promise<void>[] = [];
        for (const category of Object.keys(data) as Array<keyof SignalDataSet>) {
          const entries = data[category];
          if (!entries) continue;
          for (const [id, value] of Object.entries(entries)) {
            operations.push(
              value
                ? write(category, id, value)
                : repository.deleteSessionValue(accountId, category, id)
            );
          }
        }
        await Promise.all(operations);
      },
      clear: () => repository.deleteSessionValue(accountId)
    }
  };

  return {
    state,
    saveCreds: () => write("creds", "main", creds)
  };
}

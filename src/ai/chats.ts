import { invoke, isTauri } from "@tauri-apps/api/core";
import { deviceId, getCurrent } from "../files/files";

/**
 * AI chats, saved per board inside its `.conceit` file (not in the shared
 * board document: they are personal, and tagged with their author so they can
 * stay private once boards are collaborative). Left out of "Save a copy"
 * unless asked for.
 */

export interface ChatMeta {
  id: string;
  title: string;
  author: string;
  created: number;
  updated: number;
}

/** Chats are saved only for a board opened from a file (not in a plain browser). */
export const canSaveChats = () => isTauri() && !!getCurrent().info;

export const chats = {
  list: () => invoke<ChatMeta[]>("chat_list"),
  load: async <T,>(id: string): Promise<T | null> => {
    const raw = await invoke<string | null>("chat_load", { id });
    try {
      return raw ? (JSON.parse(raw) as T) : null;
    } catch {
      return null;
    }
  },
  save: (id: string, title: string, data: unknown) => invoke<void>("chat_save", { id, title, author: deviceId(), data: JSON.stringify(data) }),
  remove: (id?: string) => invoke<void>("chat_delete", { id }),
};

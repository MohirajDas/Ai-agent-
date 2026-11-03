import { create } from "zustand";
import { persist } from "zustand/middleware";

export type Mode = "general" | "code" | "study" | "hindi";

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
};

export type Thread = {
  id: string;
  title: string;
  mode: Mode;
  messages: ChatMessage[];
  updatedAt: number;
};

const MAX_THREADS = 24;
const MAX_MESSAGES = 30;

export const MODES: { id: Mode; label: string }[] = [
  { id: "general", label: "General" },
  { id: "code", label: "Code" },
  { id: "study", label: "Study" },
  { id: "hindi", label: "हिंदी" },
];

function uid() {
  return crypto.randomUUID();
}

function titleFrom(text: string) {
  const line = text.trim().split("\n")[0] ?? "New chat";
  const clean = line.replace(/\s+/g, " ");
  if (!clean) return "New chat";
  return clean.length > 42 ? `${clean.slice(0, 42)}…` : clean;
}

type HistoryItem = { role: "user" | "assistant"; content: string };

type ChatState = {
  threads: Thread[];
  activeId: string | null;
  draftMode: Mode;
  hydrated: boolean;
  setHydrated: (value: boolean) => void;
  setActive: (id: string | null) => void;
  setMode: (mode: Mode) => void;
  removeThread: (id: string) => void;
  clearAll: () => void;
  pushUser: (content: string) => { threadId: string; history: HistoryItem[]; mode: Mode };
  startAssistant: (threadId: string) => string;
  patchAssistant: (threadId: string, messageId: string, content: string) => void;
  dropMessage: (threadId: string, messageId: string) => void;
};

function ensureThread(get: () => ChatState, set: (partial: Partial<ChatState>) => void) {
  const current = get().activeId;
  if (current && get().threads.some((thread) => thread.id === current)) return current;
  const thread: Thread = {
    id: uid(),
    title: "New chat",
    mode: get().draftMode,
    messages: [],
    updatedAt: Date.now(),
  };
  set({
    threads: [thread, ...get().threads].slice(0, MAX_THREADS),
    activeId: thread.id,
  });
  return thread.id;
}

export const useChat = create<ChatState>()(
  persist(
    (set, get) => ({
      threads: [],
      activeId: null,
      draftMode: "general",
      hydrated: false,
      setHydrated: (value) => set({ hydrated: value }),
      setActive: (id) => {
        const thread = get().threads.find((item) => item.id === id);
        set({ activeId: id, draftMode: thread?.mode ?? get().draftMode });
      },
      setMode: (mode) => {
        const { activeId } = get();
        if (!activeId) {
          set({ draftMode: mode });
          return;
        }
        set({
          draftMode: mode,
          threads: get().threads.map((thread) =>
            thread.id === activeId ? { ...thread, mode, updatedAt: Date.now() } : thread,
          ),
        });
      },
      removeThread: (id) => {
        const threads = get().threads.filter((thread) => thread.id !== id);
        const activeId = get().activeId === id ? (threads[0]?.id ?? null) : get().activeId;
        const mode = threads.find((thread) => thread.id === activeId)?.mode ?? "general";
        set({ threads, activeId, draftMode: activeId ? mode : get().draftMode });
      },
      clearAll: () => set({ threads: [], activeId: null }),
      pushUser: (content) => {
        const threadId = ensureThread(get, set);
        const mode = get().draftMode;
        const message: ChatMessage = { id: uid(), role: "user", content };
        let history: HistoryItem[] = [];
        set({
          threads: get().threads.map((thread) => {
            if (thread.id !== threadId) return thread;
            const messages = [...thread.messages, message].slice(-MAX_MESSAGES);
            history = messages
              .filter((item) => item.content.trim())
              .map((item) => ({ role: item.role, content: item.content }));
            return {
              ...thread,
              mode,
              title: thread.messages.length === 0 ? titleFrom(content) : thread.title,
              messages,
              updatedAt: Date.now(),
            };
          }),
        });
        return { threadId, history, mode };
      },
      startAssistant: (threadId) => {
        const messageId = uid();
        const message: ChatMessage = { id: messageId, role: "assistant", content: "" };
        set({
          threads: get().threads.map((thread) =>
            thread.id === threadId
              ? {
                  ...thread,
                  messages: [...thread.messages, message].slice(-MAX_MESSAGES),
                  updatedAt: Date.now(),
                }
              : thread,
          ),
        });
        return messageId;
      },
      patchAssistant: (threadId, messageId, content) => {
        set({
          threads: get().threads.map((thread) =>
            thread.id !== threadId
              ? thread
              : {
                  ...thread,
                  updatedAt: Date.now(),
                  messages: thread.messages.map((message) =>
                    message.id === messageId ? { ...message, content } : message,
                  ),
                },
          ),
        });
      },
      dropMessage: (threadId, messageId) => {
        set({
          threads: get().threads.map((thread) =>
            thread.id === threadId
              ? { ...thread, messages: thread.messages.filter((message) => message.id !== messageId) }
              : thread,
          ),
        });
      },
    }),
    {
      name: "aaroh.v1",
      skipHydration: true,
      partialize: (state) => ({
        threads: state.threads,
        activeId: state.activeId,
        draftMode: state.draftMode,
      }),
      onRehydrateStorage: () => (state) => {
        state?.setHydrated(true);
      },
    },
  ),
);

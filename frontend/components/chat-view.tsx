"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, getToolName, isToolUIPart, type UIMessage } from "ai";
import { ArrowUp, Check, Loader2, Plus, Trash2, Wrench } from "lucide-react";
import { FormEvent, KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { ChatMarkdown } from "@/components/chat-markdown";
import {
  browserDelete,
  browserGet,
  browserPost,
  browserPut,
  type ChatDetail,
  type ChatSummary,
} from "@/lib/browser-api";
import { cn } from "@/lib/utils";

function partText(part: UIMessage["parts"][number]) {
  if (part.type === "text") return part.text;
  if (part.type === "reasoning") return part.text;
  return null;
}

function toolTitle(name: string) {
  if (name === "getDiagnosis") return "diagnosis table";
  if (name === "getDecisionLog") return "decision log";
  return name;
}

function toolStatus(part: UIMessage["parts"][number]) {
  if (!isToolUIPart(part)) return null;
  const title = toolTitle(getToolName(part));
  const state = "state" in part ? String(part.state) : "";
  const pending =
    state === "input-streaming" ||
    state === "input-available" ||
    state === "approval-requested" ||
    state === "";
  if (state === "output-error") {
    const err = "errorText" in part && part.errorText ? String(part.errorText) : "failed";
    return { pending: false, error: true, label: `${title} failed · ${err}` };
  }
  return {
    pending,
    error: false,
    label: pending ? `Using ${title}` : `Used ${title}`,
  };
}

function toUiMessages(raw: ChatDetail["messages"]): UIMessage[] {
  return raw.map((m) => ({
    id: m.id,
    role: m.role as UIMessage["role"],
    parts: (m.parts?.length
      ? m.parts
      : [{ type: "text", text: "" }]) as UIMessage["parts"],
  }));
}

function serializeMessages(messages: UIMessage[]) {
  return JSON.parse(
    JSON.stringify(
      messages.map((m) => ({
        id: m.id,
        role: m.role,
        parts: m.parts,
      })),
    ),
  );
}

function chatIdFromPath(pathname: string) {
  const match = pathname.match(/^\/agent\/chat\/([^/]+)/);
  return match?.[1] ?? null;
}

export function ChatView() {
  const pathname = usePathname();
  const router = useRouter();
  const routeId = chatIdFromPath(pathname);
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [threadKey, setThreadKey] = useState("draft");
  const [initialMessages, setInitialMessages] = useState<UIMessage[]>([]);

  async function refreshChats() {
    try {
      setChats(await browserGet<ChatSummary[]>("/chats"));
    } catch {
      setChats([]);
    }
  }

  useEffect(() => {
    void refreshChats();
  }, []);

  useEffect(() => {
    if (!routeId) {
      if (activeId) {
        setActiveId(null);
        setInitialMessages([]);
        setThreadKey(`draft-${Date.now()}`);
      }
      return;
    }
    if (routeId === activeId) return;
    let cancelled = false;
    void (async () => {
      try {
        const detail = await browserGet<ChatDetail>(`/chats/${routeId}`);
        if (cancelled) return;
        setActiveId(routeId);
        setInitialMessages(toUiMessages(detail.messages));
        setThreadKey(routeId);
      } catch {
        if (!cancelled) router.replace("/agent");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [routeId, activeId, router]);

  function newChat() {
    if (!routeId) {
      setActiveId(null);
      setInitialMessages([]);
      setThreadKey(`draft-${Date.now()}`);
      return;
    }
    router.push("/agent");
  }

  async function removeChat(id: string) {
    await browserDelete(`/chats/${id}`);
    if (routeId === id) router.push("/agent");
    await refreshChats();
  }

  return (
    <div className="flex h-full min-h-0">
      <ChatPane
        key={threadKey}
        conversationId={activeId}
        initialMessages={initialMessages}
        onPersisted={(id) => {
          setActiveId(id);
          void refreshChats();
          if (routeId !== id) router.replace(`/agent/chat/${id}`);
        }}
      />
      <aside className="flex h-full w-64 shrink-0 flex-col border-l border-border bg-background">
        <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-3">
          <p className="text-xs tracking-wide text-muted-foreground uppercase">History</p>
          <Button size="icon-sm" variant="ghost" onClick={newChat} aria-label="New chat">
            <Plus />
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {chats.length === 0 && (
            <p className="px-2 pt-4 text-xs text-muted-foreground">No saved chats yet.</p>
          )}
          {chats.map((chat) => (
            <div
              key={chat.id}
              className={cn(
                "group mb-1 flex items-center rounded-lg",
                routeId === chat.id ? "bg-secondary" : "hover:bg-muted/50",
              )}
            >
              <Link
                href={`/agent/chat/${chat.id}`}
                className="min-w-0 flex-1 px-2 py-2 text-left"
              >
                <p className="truncate text-sm">{chat.title || "New chat"}</p>
                <p className="truncate font-mono text-[10px] text-muted-foreground">
                  {chat.updated_at.slice(0, 16).replace("T", " ")}
                </p>
              </Link>
              <Button
                size="icon-xs"
                variant="ghost"
                className="mr-1 opacity-0 group-hover:opacity-100"
                aria-label="Delete chat"
                onClick={() => void removeChat(chat.id)}
              >
                <Trash2 />
              </Button>
            </div>
          ))}
        </div>
      </aside>
    </div>
  );
}

function ChatPane({
  conversationId,
  initialMessages,
  onPersisted,
}: {
  conversationId: string | null;
  initialMessages: UIMessage[];
  onPersisted: (id: string) => void;
}) {
  const params = useSearchParams();
  const context = params.get("context");
  const [input, setInput] = useState(
    context
      ? `Explain diagnosis ${context} using the diagnosis table. Never use raw rows.`
      : "",
  );
  const listRef = useRef<HTMLDivElement>(null);
  const idRef = useRef(conversationId);
  idRef.current = conversationId ?? idRef.current;

  const transport = useMemo(
    () => new DefaultChatTransport({ api: "/api/chat" }),
    [],
  );
  const { messages, sendMessage, status, error } = useChat({
    messages: initialMessages,
    transport,
    onFinish: async ({ messages: next }) => {
      try {
        let id = idRef.current;
        if (!id) {
          const created = await browserPost<ChatDetail>("/chats", { title: "New chat" });
          id = created.id;
          idRef.current = id;
        }
        await browserPut(`/chats/${id}/messages`, {
          messages: serializeMessages(next),
        });
        onPersisted(id);
      } catch {
        /* keep chatting even if persist fails */
      }
    },
  });
  const streaming = status === "submitted" || status === "streaming";

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, status]);

  function submit() {
    const text = input.trim();
    if (!text || streaming) return;
    void sendMessage({ text });
    setInput("");
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    submit();
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="mx-auto flex max-w-3xl flex-col gap-3">
          {messages.length === 0 && (
            <p className="pt-8 text-center text-sm text-muted-foreground">
              Ask why a flag fired. Answers come from artifacts only.
            </p>
          )}
          {messages.map((message, index) => {
            const fromUser = message.role === "user";
            const texts = message.parts.map(partText).filter((t): t is string => Boolean(t));
            const tools = message.parts
              .map(toolStatus)
              .filter((t): t is NonNullable<ReturnType<typeof toolStatus>> => Boolean(t));
            const isLast = index === messages.length - 1;
            const waitingOnReply = !fromUser && streaming && isLast && texts.length === 0;
            if (fromUser) {
              return (
                <article key={message.id} className="flex w-full justify-end pl-16">
                  <div className="max-w-[min(36rem,100%)] rounded-2xl bg-secondary px-3 py-2 text-sm text-secondary-foreground">
                    <p className="mb-1 text-[10px] tracking-wide text-muted-foreground uppercase">
                      You
                    </p>
                    <div>
                      {texts.map((text, i) => (
                        <ChatMarkdown key={i} text={text} />
                      ))}
                    </div>
                  </div>
                </article>
              );
            }
            if (!texts.length && !tools.length && !waitingOnReply) return null;
            return (
              <div key={message.id} className="flex w-full flex-col items-start gap-2 pr-16">
                {tools.map((tool, i) => (
                  <div
                    key={`${message.id}-tool-${i}`}
                    className={cn(
                      "flex items-center gap-2 rounded-full border px-3 py-1 text-xs",
                      tool.error
                        ? "border-red-500/40 text-red-400"
                        : "border-border bg-muted/40 text-muted-foreground",
                    )}
                  >
                    {tool.pending ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : tool.error ? (
                      <Wrench className="size-3.5" />
                    ) : (
                      <Check className="size-3.5" />
                    )}
                    <span>{tool.label}</span>
                  </div>
                ))}
                {waitingOnReply && tools.length === 0 && (
                  <p className="pl-1 text-xs text-muted-foreground">Thinking…</p>
                )}
                {texts.length > 0 && (
                  <article className="max-w-[min(36rem,100%)] rounded-2xl border border-border bg-card px-3 py-2 text-sm text-card-foreground">
                    <p className="mb-1 text-[10px] tracking-wide text-muted-foreground uppercase">
                      Assistant
                    </p>
                    <div>
                      {texts.map((text, i) => (
                        <ChatMarkdown key={i} text={text} />
                      ))}
                    </div>
                  </article>
                )}
              </div>
            );
          })}
          {streaming && messages.at(-1)?.role !== "assistant" && (
            <p className="pl-1 text-xs text-muted-foreground">Thinking…</p>
          )}
          {error && (
            <p className="pl-1 text-xs text-red-400">
              {error.message || "The agent failed before it could answer."}
            </p>
          )}
        </div>
      </div>

      <form
        onSubmit={onSubmit}
        className="shrink-0 border-t border-border bg-background px-4 py-3"
      >
        <div className="mx-auto flex max-w-3xl items-end gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Ask why a flag fired"
            rows={1}
            disabled={streaming}
            className="max-h-24 min-h-10 flex-1 resize-none overflow-y-auto rounded-lg border border-input bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
          />
          <Button
            type="submit"
            size="icon"
            disabled={streaming || !input.trim()}
            aria-label="Send"
          >
            {streaming ? <Loader2 className="animate-spin" /> : <ArrowUp />}
          </Button>
        </div>
      </form>
    </div>
  );
}

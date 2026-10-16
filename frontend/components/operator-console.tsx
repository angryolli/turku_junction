"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import {
  Activity,
  Bot,
  Check,
  HelpCircle,
  Send,
  ShieldAlert,
  User,
} from "lucide-react";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";

type LogEntry = {
  ts: string;
  kind: string;
  payload: unknown;
};

function partText(part: UIMessage["parts"][number]) {
  if (part.type === "text") return part.text;
  if (part.type.startsWith("tool-")) return part.type.replace("tool-", "");
  return null;
}

function statusLabel(status: string) {
  if (status === "streaming" || status === "submitted") return "Running";
  if (status === "error") return "Error";
  return "Ready";
}

export function OperatorConsole() {
  const [input, setInput] = useState("");
  const [note, setNote] = useState("");
  const [log, setLog] = useState<LogEntry[]>([]);

  const transport = useMemo(
    () => new DefaultChatTransport({ api: "/api/chat" }),
    [],
  );

  const { messages, sendMessage, status } = useChat({
    transport,
  });

  async function refreshLog() {
    const res = await fetch("/api/review", { cache: "no-store" });
    if (!res.ok) return;
    const data: { entries: LogEntry[] } = await res.json();
    setLog(data.entries);
  }

  useEffect(() => {
    void refreshLog();
  }, [messages.length]);

  async function review(action: "accept" | "question" | "override") {
    await fetch("/api/review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, note }),
    });
    setNote("");
    await refreshLog();
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = input.trim();
    if (!text || status !== "ready") return;
    void sendMessage({ text });
    setInput("");
  }

  const busy = status !== "ready";

  return (
    <div className="flex min-h-svh flex-col bg-muted/40">
      <header className="border-b bg-background">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-6 py-4">
          <div>
            <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              Trustworthy process monitor
            </p>
            <h1 className="font-heading text-xl font-medium">Operator console</h1>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant={status === "error" ? "destructive" : "secondary"}>
              Agent {statusLabel(status)}
            </Badge>
            <Badge variant="outline">Summaries only</Badge>
          </div>
        </div>
      </header>

      <div className="mx-auto grid w-full max-w-6xl flex-1 gap-6 p-6 md:grid-cols-[minmax(0,1fr)_22rem]">
        <Card className="min-h-[70svh]">
          <CardHeader className="border-b">
            <CardTitle>Diagnosis</CardTitle>
            <CardDescription>
              The Next.js agent interprets pipeline artifacts. Raw data-source rows
              stay in the operator environment.
            </CardDescription>
            <CardAction>
              <Button
                size="sm"
                disabled={busy}
                onClick={() =>
                  void sendMessage({
                    text: "Generate the initial data understanding report from the pipeline artifacts. Start with data quality.",
                  })
                }
              >
                <Activity data-icon="inline-start" />
                Run report
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent className="flex min-h-0 flex-1 flex-col p-0">
            <ScrollArea className="h-[calc(70svh-11rem)]">
              <div className="space-y-3 p-4">
                {messages.length === 0 && (
                  <div className="flex flex-col items-center justify-center gap-2 py-16 text-center text-muted-foreground">
                    <Bot className="size-8" />
                    <p className="text-sm">
                      Run a report or ask why a flag fired.
                    </p>
                  </div>
                )}
                {messages.map((message) => {
                  const isUser = message.role === "user";
                  return (
                    <div
                      key={message.id}
                      className={`flex gap-2 ${isUser ? "justify-end" : "justify-start"}`}
                    >
                      {!isUser && (
                        <div className="mt-1 flex size-7 shrink-0 items-center justify-center rounded-full bg-secondary">
                          <Bot className="size-3.5" />
                        </div>
                      )}
                      <div
                        className={`max-w-[85%] rounded-xl px-3 py-2 text-sm ${
                          isUser
                            ? "bg-primary text-primary-foreground"
                            : "bg-muted"
                        }`}
                      >
                        <p className="mb-1 text-[10px] font-medium tracking-wide uppercase opacity-70">
                          {isUser ? "Operator" : "Agent"}
                        </p>
                        <div className="space-y-2 whitespace-pre-wrap">
                          {message.parts.map((part, index) => {
                            const text = partText(part);
                            if (!text) return null;
                            if (part.type.startsWith("tool-")) {
                              return (
                                <Badge
                                  key={index}
                                  variant="outline"
                                  className="font-mono"
                                >
                                  {text}
                                </Badge>
                              );
                            }
                            return <p key={index}>{text}</p>;
                          })}
                        </div>
                      </div>
                      {isUser && (
                        <div className="mt-1 flex size-7 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
                          <User className="size-3.5" />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </ScrollArea>
          </CardContent>
          <CardFooter>
            <form onSubmit={onSubmit} className="flex w-full gap-2">
              <Input
                value={input}
                onChange={(event) => setInput(event.target.value)}
                placeholder="Ask why a flag fired, or challenge a diagnosis"
                disabled={busy}
              />
              <Button type="submit" disabled={busy || !input.trim()}>
                <Send data-icon="inline-start" />
                Send
              </Button>
            </form>
          </CardFooter>
        </Card>

        <aside className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Human review</CardTitle>
              <CardDescription>
                Accept, question, or override the latest conclusion.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <Textarea
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder="Optional note for the decision log"
                rows={3}
              />
              <div className="flex flex-wrap gap-2">
                <Button size="sm" onClick={() => void review("accept")}>
                  <Check data-icon="inline-start" />
                  Accept
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void review("question")}
                >
                  <HelpCircle data-icon="inline-start" />
                  Question
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={() => void review("override")}
                >
                  <ShieldAlert data-icon="inline-start" />
                  Override
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card className="flex-1">
            <CardHeader>
              <CardTitle>Decision log</CardTitle>
              <CardDescription>
                Model calls, tools, and operator overrides.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ScrollArea className="h-72">
                {log.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No decisions yet.
                  </p>
                ) : (
                  <ul className="space-y-3">
                    {log.map((entry, index) => (
                      <li key={`${entry.ts}-${index}`}>
                        {index > 0 && <Separator className="mb-3" />}
                        <div className="flex items-center justify-between gap-2">
                          <Badge variant="secondary">{entry.kind}</Badge>
                          <span className="text-[11px] text-muted-foreground">
                            {new Date(entry.ts).toLocaleTimeString()}
                          </span>
                        </div>
                        <pre className="mt-2 overflow-x-auto text-[11px] leading-relaxed text-muted-foreground">
                          {JSON.stringify(entry.payload, null, 2)}
                        </pre>
                      </li>
                    ))}
                  </ul>
                )}
              </ScrollArea>
            </CardContent>
          </Card>
        </aside>
      </div>
    </div>
  );
}

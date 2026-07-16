import Link from "next/link";
import { notFound } from "next/navigation";
import { apiGet } from "@/lib/api";
import { Card } from "@/components/ui/Card";
import { ReplyBox } from "./ReplyBox";

interface ToolCall {
  name: string;
  isError?: boolean;
}

interface Message {
  role: "user" | "assistant" | "system_note";
  content: string;
  toolCalls: ToolCall[] | unknown;
  createdAt: string;
}

interface Detail {
  conversation: {
    id: string;
    phone: string;
    status: "active" | "escalated" | "closed";
    clientName: string | null;
    lastMessageAt: string;
  };
  messages: Message[];
}

const STATUS_NOTE: Record<Detail["conversation"]["status"], string> = {
  active: "The AI is handling this thread. Sending a reply takes it over.",
  escalated: "You've taken this over — the AI won't reply here.",
  closed: "This conversation is closed. A reply reopens it under your control.",
};

export default async function ConversationPage({
  params,
}: {
  params: { id: string };
}) {
  const res = await apiGet<Detail>(
    `/api/dashboard/receptionist/conversations/${params.id}`,
  );
  if (!res.data) notFound();
  const { conversation, messages } = res.data;
  const who = conversation.clientName ?? conversation.phone;

  return (
    <main className="mx-auto w-full max-w-2xl px-5 py-8">
      <Link
        href="/dashboard/inbox"
        className="text-xs text-muted transition-colors duration-150 ease-out hover:text-offwhite"
      >
        ← Inbox
      </Link>
      <h1 className="mb-1 mt-1 font-display text-2xl tracking-tight">{who}</h1>
      <p className="mb-5 text-xs text-muted">
        {conversation.phone} · {STATUS_NOTE[conversation.status]}
      </p>

      <Card className="mb-4 overflow-hidden">
        <div className="flex flex-col gap-3 px-4 py-4">
          {messages.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted">No messages yet.</p>
          ) : (
            messages.map((m, i) => <MessageBubble key={i} message={m} />)
          )}
        </div>
      </Card>

      <ReplyBox conversationId={conversation.id} />
    </main>
  );
}

function MessageBubble({ message }: { message: Message }) {
  // system_note: a faint centered audit line (escalations, "manual reply", etc.)
  if (message.role === "system_note") {
    return (
      <p className="self-center text-center text-[11px] italic text-muted">
        {message.content}
      </p>
    );
  }
  const fromClient = message.role === "user";
  const calls = Array.isArray(message.toolCalls)
    ? (message.toolCalls as ToolCall[])
    : [];
  return (
    <div
      className={`flex flex-col ${fromClient ? "items-start" : "items-end"}`}
    >
      <div
        className={
          fromClient
            ? "max-w-[85%] rounded-2xl rounded-bl-sm bg-charcoal-700 px-3.5 py-2 text-sm text-offwhite"
            : "max-w-[85%] rounded-2xl rounded-br-sm bg-gold/15 px-3.5 py-2 text-sm text-offwhite"
        }
      >
        {message.content || (
          <span className="text-muted">(no text — tool actions only)</span>
        )}
      </div>
      {calls.length > 0 && (
        <p className="mt-1 text-[10px] text-muted">
          {calls.map((c) => `${c.name}${c.isError ? " ⚠" : ""}`).join(" · ")}
        </p>
      )}
      <p className="mt-0.5 text-[10px] text-muted">
        {new Date(message.createdAt).toLocaleString(undefined, {
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        })}
      </p>
    </div>
  );
}

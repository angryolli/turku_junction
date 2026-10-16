import type { ReactNode } from "react";

function renderInline(text: string, keyBase: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const re =
    /(\*\*[^*]+?\*\*|__[^_]+?__|`[^`]+`|\*[^*]+?\*|_[^_]+?_|\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) {
      nodes.push(text.slice(last, m.index));
    }
    const token = m[0];
    const key = `${keyBase}-${i++}`;
    if (token.startsWith("**") || token.startsWith("__")) {
      nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("`")) {
      nodes.push(
        <code key={key} className="rounded bg-muted px-1 py-px font-mono text-[0.8em]">
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith("[")) {
      const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (link) {
        nodes.push(
          <a
            key={key}
            href={link[2]}
            className="underline underline-offset-2"
            target="_blank"
            rel="noreferrer"
          >
            {link[1]}
          </a>,
        );
      } else {
        nodes.push(token);
      }
    } else {
      nodes.push(<em key={key}>{token.slice(1, -1)}</em>);
    }
    last = m.index + token.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function isHr(line: string) {
  return /^(?:-{3,}|\*{3,}|_{3,})$/.test(line.trim());
}

function flushList(
  items: { ordered: boolean; nodes: ReactNode[][] },
  key: string,
): ReactNode {
  const Tag = items.ordered ? "ol" : "ul";
  return (
    <Tag
      key={key}
      className={items.ordered ? "my-2 list-decimal space-y-1 pl-5" : "my-2 list-disc space-y-1 pl-5"}
    >
      {items.nodes.map((n, i) => (
        <li key={`${key}-${i}`}>{n}</li>
      ))}
    </Tag>
  );
}

export function ChatMarkdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: ReactNode[] = [];
  let para: string[] = [];
  let list: { ordered: boolean; nodes: ReactNode[][] } | null = null;
  let code: string[] | null = null;
  let block = 0;

  const flushPara = () => {
    if (!para.length) return;
    const body = para.join("\n");
    out.push(
      <p key={`p-${block++}`} className="mb-2 last:mb-0">
        {renderInline(body, `p-${block}`)}
      </p>,
    );
    para = [];
  };

  const flushListIf = () => {
    if (!list) return;
    out.push(flushList(list, `l-${block++}`));
    list = null;
  };

  for (const line of lines) {
    if (code) {
      if (line.trim().startsWith("```")) {
        out.push(
          <pre
            key={`c-${block++}`}
            className="my-2 overflow-x-auto rounded-md bg-muted p-2 font-mono text-xs"
          >
            <code>{code.join("\n")}</code>
          </pre>,
        );
        code = null;
      } else {
        code.push(line);
      }
      continue;
    }

    if (line.trim().startsWith("```")) {
      flushPara();
      flushListIf();
      code = [];
      continue;
    }

    if (isHr(line)) {
      flushPara();
      flushListIf();
      out.push(<hr key={`hr-${block++}`} className="my-3 border-border" />);
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      flushPara();
      flushListIf();
      const level = heading[1].length;
      const cls =
        level === 1 ? "mb-2 text-base font-semibold" : "mb-2 text-sm font-semibold";
      const Tag = (level === 1 ? "h3" : "h4") as "h3" | "h4";
      out.push(
        <Tag key={`h-${block++}`} className={cls}>
          {renderInline(heading[2], `h-${block}`)}
        </Tag>,
      );
      continue;
    }

    const ul = line.match(/^\s*[-*+]\s+(.+)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (ul || ol) {
      flushPara();
      const ordered = Boolean(ol);
      const item = renderInline((ul?.[1] ?? ol?.[1]) as string, `li-${block}-${list?.nodes.length ?? 0}`);
      if (!list || list.ordered !== ordered) {
        flushListIf();
        list = { ordered, nodes: [item] };
      } else {
        list.nodes.push(item);
      }
      continue;
    }

    if (line.trim() === "") {
      flushPara();
      flushListIf();
      continue;
    }

    flushListIf();
    para.push(line);
  }

  if (code) {
    out.push(
      <pre key={`c-${block++}`} className="my-2 overflow-x-auto rounded-md bg-muted p-2 font-mono text-xs">
        <code>{code.join("\n")}</code>
      </pre>,
    );
  }
  flushPara();
  flushListIf();
  return <div className="text-sm leading-relaxed">{out}</div>;
}

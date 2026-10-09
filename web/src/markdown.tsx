import { t } from "./i18n";
import { createElement, useState, type ReactNode } from "react";

/**
 * Mini-rendu markdown (sous-ensemble : headings, gras/italique/code inline,
 * blocs de code, listes, liens) → éléments React purs. Pas de HTML injecté :
 * tout passe par des text nodes, sûr par construction.
 */

function safeLink(href: string): boolean {
  try { return ["http:", "https:", "mailto:"].includes(new URL(href, "https://markdown.invalid/").protocol); }
  catch { return false; }
}

function renderInline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  // tokens : `code`, **gras**, *italique*, [texte](url)
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\n]+\*)|(\[[^\]]+\]\([^)\s]+\))/g;
  let last = 0;
  let i = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    const key = `${keyBase}-${i++}`;
    if (tok.startsWith("`")) {
      out.push(<code key={key} className="md-code">{tok.slice(1, -1)}</code>);
    } else if (tok.startsWith("**")) {
      out.push(<strong key={key}>{tok.slice(2, -2)}</strong>);
    } else if (tok.startsWith("*")) {
      out.push(<em key={key}>{tok.slice(1, -1)}</em>);
    } else {
      const lm = tok.match(/\[([^\]]+)\]\(([^)\s]+)\)/)!;
      out.push(safeLink(lm[2]!)
        ? <a key={key} className="md-link" href={lm[2]} target="_blank" rel="noreferrer">{lm[1]}</a>
        : <span key={key}>{lm[1]}</span>);
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function splitRow(line: string): string[] {
  // découpe simple : pas de gestion des pipes échappés (\|) — ponytail: suffisant pour l'output d'agents
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|");
}

function CodeBlock({ text, language }: { text: string; language: string }) {
  const [copy, setCopy] = useState<"idle" | "pending" | "done" | "error">("idle");
  async function copyCode() {
    setCopy("pending");
    try {
      await navigator.clipboard.writeText(text);
      setCopy("done");
    } catch {
      setCopy("error");
    }
  }
  return <div className="md-code-block">
    <div className="md-code-head">
      <span>{language || t("chat.text")}</span>
      <button type="button" className="btn btn-sm" disabled={copy === "pending"} onClick={copyCode}>
        {copy === "error" ? t("chat.retryCopy") : t("chat.copyCode")}
      </button>
      <span role="status" className={copy === "error" ? "is-error" : undefined}>{copy === "done" ? t("chat.copied") : copy === "pending" ? t("chat.copying") : copy === "error" ? t("chat.copyError") : ""}</span>
    </div>
    <pre className="md-pre" tabIndex={0} aria-label={t("chat.codeBlock")}><code>{text}</code></pre>
  </div>;
}

export function Markdown(props: { text: string }) {
  const lines = props.text.split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;
  let headingBase: number | null = null;

  while (i < lines.length) {
    const line = lines[i]!;

    // bloc de code ```lang ... ```
    const fence = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (fence) {
      const marker = fence[1]!;
      const closing = new RegExp(`^\\s*${marker[0]}{${marker.length},}\\s*$`);
      const buf: string[] = [];
      i++;
      while (i < lines.length && !closing.test(lines[i]!)) {
        buf.push(lines[i]!);
        i++;
      }
      i++; // ferme ```
      blocks.push(<CodeBlock key={key++} text={buf.join("\n")} language={fence[2]!.trim()} />);
      continue;
    }

    // ligne vide
    if (line.trim() === "") {
      i++;
      continue;
    }

    // heading
    const hm = line.match(/^(#{1,6})\s+(.*)$/);
    if (hm) {
      headingBase ??= hm[1]!.length;
      const level = hm[1]!.length <= headingBase ? 2 : 3;
      const cls = level <= 2 ? "md-h2" : "md-h3";
      blocks.push(createElement(`h${level}`, { key: key++, className: cls }, renderInline(hm[2]!, `h${key}`)));
      i++;
      continue;
    }

    if (/^\s*>/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i]!)) {
        quote.push(lines[i++]!.replace(/^\s*> ?/, ""));
      }
      blocks.push(<blockquote key={key++} className="md-quote"><Markdown text={quote.join("\n")} /></blockquote>);
      continue;
    }

    // liste (à puces ou numérotée)
    if (/^\s*([-*•]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\.\s+/.test(line);
      const listPattern = ordered ? /^\s*\d+\.\s+/ : /^\s*[-*•]\s+/;
      const List = ordered ? "ol" : "ul";
      const start = ordered ? Number(line.match(/^\s*(\d+)\./)![1]) : undefined;
      const items: string[] = [];
      while (i < lines.length && listPattern.test(lines[i]!)) {
        items.push(lines[i]!.replace(/^\s*([-*•]|\d+\.)\s+/, ""));
        i++;
      }
      blocks.push(
        <List key={key++} className="md-list" start={start}>
          {items.map((it, j) => {
            const task = it.match(/^\[([ xX])\]\s+(.*)$/);
            return <li key={j} className={task ? "md-task" : undefined}>{task
              ? <label><input type="checkbox" checked={task[1]!.toLowerCase() === "x"} disabled />{renderInline(task[2]!, `l${key}-${j}`)}</label>
              : renderInline(it, `l${key}-${j}`)}</li>;
          })}
        </List>,
      );
      continue;
    }

    // tableau markdown (lignes | consécutives, ligne séparatrice |---|)
    if (line.trim().startsWith("|")) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.trim().startsWith("|")) {
        rows.push(splitRow(lines[i]!));
        i++;
      }
      const isSep = (cells: string[]) => cells.every((c) => /^:?-{2,}:?$/.test(c.trim()));
      if (rows.length >= 2 && isSep(rows[1]!)) rows.splice(1, 1);
      const [head, ...body] = rows;
      if (head) {
        blocks.push(
          <div key={key++} className="md-table-wrap" tabIndex={0} role="region" aria-label={t("chat.table")}>
            <p className="md-scroll-hint">{t("chat.horizontalScroll")}</p>
            <table className="md-table">
              <thead>
                <tr>{head.map((c, j) => <th key={j} scope="col">{renderInline(c.trim(), `t${key}h${j}`)}</th>)}</tr>
              </thead>
              <tbody>
                {body.map((r, ri) => (
                  <tr key={ri}>{r.map((c, ci) => <td key={ci}>{renderInline(c.trim(), `t${key}b${ri}-${ci}`)}</td>)}</tr>
                ))}
              </tbody>
            </table>
          </div>,
        );
      }
      continue;
    }

    // paragraphe (lignes consécutives non vides)
    const buf: string[] = [line];
    i++;
    while (i < lines.length && lines[i]!.trim() !== "" && !/^(#{1,6}\s|\s*([-_*•]|\d+\.)\s|\s*(`{3,}|~{3,}|>)|\s*\|)/.test(lines[i]!)) {
      buf.push(lines[i]!);
      i++;
    }
    blocks.push(<p key={key++} className="md-p">{renderInline(buf.join("\n"), `p${key}`)}</p>);
  }

  return <div className="md">{blocks}</div>;
}

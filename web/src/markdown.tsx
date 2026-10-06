import { Fragment, type ReactNode } from "react";

/**
 * Mini-rendu markdown (sous-ensemble : headings, gras/italique/code inline,
 * blocs de code, listes, liens) → éléments React purs. Pas de HTML injecté :
 * tout passe par des text nodes, sûr par construction.
 */

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
      out.push(<a key={key} className="md-link" href={lm[2]} target="_blank" rel="noreferrer">{lm[1]}</a>);
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown(props: { text: string }) {
  const lines = props.text.split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    // bloc de code ```lang ... ```
    if (line.trim().startsWith("```")) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trim().startsWith("```")) {
        buf.push(lines[i]!);
        i++;
      }
      i++; // ferme ```
      blocks.push(<pre key={key++} className="md-pre">{buf.join("\n")}</pre>);
      continue;
    }

    // ligne vide
    if (line.trim() === "") {
      i++;
      continue;
    }

    // heading
    const hm = line.match(/^(#{1,4})\s+(.*)$/);
    if (hm) {
      const level = hm[1]!.length;
      const cls = level <= 2 ? "md-h2" : "md-h3";
      blocks.push(<div key={key++} className={cls}>{renderInline(hm[2]!, `h${key}`)}</div>);
      i++;
      continue;
    }

    // liste (à puces ou numérotée)
    if (/^\s*([-*•]|\d+\.)\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*•]|\d+\.)\s+/.test(lines[i]!)) {
        items.push(lines[i]!.replace(/^\s*([-*•]|\d+\.)\s+/, ""));
        i++;
      }
      blocks.push(
        <ul key={key++} className="md-list">
          {items.map((it, j) => <li key={j}>{renderInline(it, `l${key}-${j}`)}</li>)}
        </ul>,
      );
      continue;
    }

    // paragraphe (lignes consécutives non vides)
    const buf: string[] = [line];
    i++;
    while (i < lines.length && lines[i]!.trim() !== "" && !/^(#{1,4}\s|\s*([-*•]|\d+\.)\s|```)/.test(lines[i]!)) {
      buf.push(lines[i]!);
      i++;
    }
    blocks.push(<p key={key++} className="md-p">{renderInline(buf.join("\n"), `p${key}`)}</p>);
  }

  return <div className="md">{blocks}</div>;
}

/** Version inline simple (pour une ligne courte, ex. meta). */
export function InlineMd(props: { text: string }) {
  return <>{renderInline(props.text, "i")}</>;
}

void Fragment;

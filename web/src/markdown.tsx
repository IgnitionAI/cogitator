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

function splitRow(line: string): string[] {
  // découpe simple : pas de gestion des pipes échappés (\|) — ponytail: suffisant pour l'output d'agents
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|");
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
          <div key={key++} className="md-table-wrap">
            <table className="md-table">
              <thead>
                <tr>{head.map((c, j) => <th key={j}>{renderInline(c.trim(), `t${key}h${j}`)}</th>)}</tr>
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
    while (i < lines.length && lines[i]!.trim() !== "" && !/^(#{1,4}\s|\s*([-_*•]|\d+\.)\s|```|\s*\|)/.test(lines[i]!)) {
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

import { UI_INSTRUCTIONS, parseUI, parseUIResponse, splitUIBlocks, uiRequestKey, type UIResponse } from "../../src/generative-ui";
import { GenerativeUI, UIResponseSummary } from "./GenerativeUI";
import { Markdown } from "./markdown";

// Keep old manually requested interfaces readable when replaying existing transcripts.
const UI_REQUEST = `Propose une interface interactive pour la prochaine décision utile de notre échange. Ne lance aucune opération sur cette seule demande.\n\n${UI_INSTRUCTIONS}`;

export function AssistantContent(props: {
  text: string;
  responses: Map<string, UIResponse>;
  disabled: boolean;
  streaming?: boolean;
  onSubmit: (text: string) => Promise<void>;
}) {
  return splitUIBlocks(props.text).map((block, index) => {
    if (block.kind === "markdown") return <Markdown key={index} text={block.text} />;
    const parsed = block.complete ? parseUI(block.source) : null;
    const response = parsed?.ok ? props.responses.get(uiRequestKey(parsed.value)) : undefined;
    return <GenerativeUI key={index} source={block.source} complete={block.complete} streaming={props.streaming} response={response} disabled={props.disabled} onSubmit={props.onSubmit} />;
  });
}

export function UserContent({ text }: { text: string }) {
  const response = parseUIResponse(text);
  if (response) return <UIResponseSummary response={response} />;
  if (text === UI_REQUEST) return (
    <details className="ui-request">
      <summary>Demande d’interface interactive</summary>
      <p>L’agent reçoit le format des composants disponibles. Aucune opération n’est autorisée par cette demande.</p>
      <details><summary>Voir les instructions transmises</summary><pre tabIndex={0}>{text}</pre></details>
    </details>
  );
  return <Markdown text={text} />;
}

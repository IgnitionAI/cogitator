import { t, formatDate, formatTime, formatNumber } from "./i18n";
import type { FeedEvent } from "./types";

const DAY_FORMAT: Intl.DateTimeFormatOptions = { weekday: "long", day: "numeric", month: "long", year: "numeric" };
const TIME_FORMAT: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit" };

/** Regroupe les événements par jour local (ordre d'entrée conservé). */
function groupByDay(events: FeedEvent[]): Array<[string, FeedEvent[]]> {
  const days = new Map<string, FeedEvent[]>();
  for (const event of events) {
    const day = formatDate(event.at, DAY_FORMAT);
    const list = days.get(day);
    if (list) list.push(event);
    else days.set(day, [event]);
  }
  return [...days.entries()];
}

/** Feed chronologique groupé par jour — partagé par la liste des workspaces et la page workspace. */
export function FeedList(props: { feed: FeedEvent[]; onOpenEvent: (event: FeedEvent) => void }) {
  return (
    <div>
      {groupByDay(props.feed).map(([day, events]) => (
        <div key={day}>
          <div className="feed-day">{day}</div>
          {events.map((event) => (
            <button
              type="button"
              key={`${event.conversationId}:${event.path}:${event.at}`}
              className="feed-row"
              onClick={() => props.onOpenEvent(event)}
              title={event.path}
              aria-label={t("workspace.feedChanges", { path: event.path, title: !event.conversationTitle || event.conversationTitle === "(sans titre)" ? t("workspace.untitled") : event.conversationTitle, date: formatDate(event.at) })}
            >
              <span className="feed-time">{formatTime(event.at, TIME_FORMAT)}</span>
              <span className="feed-conv">{!event.conversationTitle || event.conversationTitle === "(sans titre)" ? t("workspace.untitled") : event.conversationTitle}</span>
              <span className="feed-path mono">{event.path.split("/").slice(-2).join("/")}</span>
              <span className="file-stats">
                {event.additions > 0 ? <span className="add">+{formatNumber(event.additions)}</span> : null}
                {event.deletions > 0 ? <span className="del">−{formatNumber(event.deletions)}</span> : null}
              </span>
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

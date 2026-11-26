/**
 * What the Users screen shows for a site that has never sent a `user_id`: why the numbers are
 * missing, and the few lines that send one, for the three ways an app reports to NsMetry (the
 * `nsmetry` nshm for NSH apps, the `nsmetry` npm package, the plain HTTP API). The snippets carry
 * this instance's address and the current site, so they can be pasted as they are.
 */
import { signal, View } from "nsh";
import { currentServer, currentSite } from "../../store";
import { Card, CodeBlock, Glyph, Heading, InlineCode, PillTabs, Txt } from "../../ui";

type Way = "nsh" | "js" | "http";

const ways: { value: Way; label: string }[] = [
  { value: "nsh", label: "NSH app" },
  { value: "js", label: "JavaScript" },
  { value: "http", label: "HTTP" },
];

function snippet(way: Way, endpoint: string, site: string): string {
  switch (way) {
    case "nsh":
      return `// nsh add nsmetry
import { createNsMetry } from "nsmetry";

export const nsmetry = createNsMetry({
  endpoint: "${endpoint}",
  site: "${site}",
  persistUserId: true, // a random install id, kept in Storage
});`;
    case "js":
      return `// npm install nsmetry
import { createNsMetry } from "nsmetry";

const nsmetry = createNsMetry({
  endpoint: "${endpoint}",
  site: "${site}",
  persistUserId: true, // or userId: an anonymous id you already have
});`;
    case "http":
      return `curl -X POST ${endpoint}/api/events/batch \\
  -H 'content-type: application/json' \\
  -d '{"site":"${site}","events":[
    {"name":"screen_view","url":"/home","user_id":"<install id>","app_version":"1.0.0"}
  ]}'`;
  }
}

export function UserIdSetup(props: { testID?: string }) {
  const way = signal<Way>("nsh");
  const endpoint = () => currentServer() || "https://stats.example.com";
  const site = () => currentSite()?.domain ?? "my-app";
  return (
    <Card testID={props.testID} class="gap-4">
      <View class="flex-row items-start gap-3">
        <Glyph name="users" size={20} tone="faint" />
        <View class="flex-1 gap-1">
          <Heading size="lead">No user ids from {site()} yet</Heading>
          <Txt tone="muted">
            Active users and retention count installs, so they need a stable, anonymous id with each event. Send it as{" "}
            <InlineCode>user_id</InlineCode>: the server hashes it with a per-site secret and never stores it as sent.
            Page and event counts work without it.
          </Txt>
        </View>
      </View>
      <PillTabs accessibilityLabel="Send a user id from" options={ways} value={way()} onChange={(w) => way.set(w)} testID="user-id-way" />
      <CodeBlock testID="user-id-snippet" label="snippet" code={snippet(way(), endpoint(), site())} />
      <Txt size="caption" tone="muted">
        Use an id of the install, not of a person: a random value made on first launch is enough. This screen fills in as soon
        as the first events with an id arrive.
      </Txt>
    </Card>
  );
}

/**
 * Team (admin only): who can sign in, and which sites each viewer reads. There are no passwords:
 * inviting an email lets it ask for a sign-in code; nothing is mailed at invite time, so the toast
 * after an invite says where to send the person.
 *
 * The list is a table (person, role, sites, added); a row pushes the person's page, where a viewer's
 * sites are edited and access is removed (after a confirmation; then the page pops). The
 * administrator (named by ADMIN_EMAIL at deploy time) reads every site and cannot be removed here, so
 * its page only describes it.
 */
import { effect, resource, signal, View } from "nsh";
import { ApiError, type PublicUser } from "../api";
import { api, closeDetail, currentServer, currentUser, isOwner, openDetail, siteList } from "../store";
import {
  Avatar, Button, Card, ConfirmDialog, DataTable, EmptyState, Field, Heading, Modal, PropertyList,
  Skeleton, Tag, TextInput, toast, touch, Txt,
} from "../ui";
import { ScreenFrame } from "./frame";
import { SiteChecklist } from "./settings/site-checklist";
import { ago, day } from "./settings/time";

const isAdmin = (u: PublicUser) => u.role === "owner";
const sameIds = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((x) => b.includes(x));

/** "All sites" for the admin, "None" / "example.com" / "3 sites" for a viewer. */
function sitesLabel(u: PublicUser): string {
  if (isAdmin(u)) return "All sites";
  if (u.siteIds.length === 0) return "None";
  if (u.siteIds.length === 1) return siteList().find((s) => s.id === u.siteIds[0])?.domain ?? "1 site";
  return `${u.siteIds.length} sites`;
}

// ------------------------------------------------------------------------------------- invite

function InviteDialog(props: { open: boolean; onClose: () => void; onInvited: (u: PublicUser) => void }) {
  const email = signal("");
  const sites = signal<number[]>([]);
  const busy = signal(false);
  const error = signal<string | null>(null);
  const reset = () => { email.set(""); sites.set([]); error.set(null); };
  const close = () => { reset(); props.onClose(); };
  const submit = async () => {
    const address = email().trim();
    if (!address.includes("@")) { error.set("Enter an email address."); return; }
    busy.set(true);
    error.set(null);
    try {
      const { user } = await api.inviteUser(address, sites());
      reset();
      props.onInvited(user);
    } catch (e) {
      error.set(e instanceof ApiError ? e.message : "Couldn't invite them.");
    } finally {
      busy.set(false);
    }
  };
  return (
    <Modal
      testID="invite-dialog"
      open={props.open}
      onClose={close}
      title="Invite someone"
      description="They sign in with a code sent to this address and read only the sites you pick."
      actions={
        <>
          <Button label="Cancel" variant="ghost" block={touch} onPress={close} />
          <Button label="Invite" variant="primary" block={touch} busy={busy()} disabled={!email().trim()} onPress={() => void submit()} testID="invite-submit" />
        </>
      }
    >
      <Field label="Email" error={error()}>
        <TextInput
          testID="invite-email"
          value={email()}
          onChange={(v) => { email.set(v); error.set(null); }}
          onSubmit={() => void submit()}
          placeholder="name@example.com"
          keyboard="email-address"
          autoComplete="email"
          plain
          autoFocus
          invalid={!!error()}
          accessibilityLabel="Email"
        />
      </Field>
      <Field label="Sites">
        <SiteChecklist testID="invite-sites" sites={siteList()} selected={sites()} onChange={(ids) => sites.set(ids)} />
      </Field>
    </Modal>
  );
}

// ------------------------------------------------------------------------------------- person page

/**
 * One person's page. A viewer's sites are a draft until Save; "Remove access…" asks in a dialog over
 * the page, and `onRemove` resolves true once they are gone (the screen then pops the page).
 */
function PersonDetail(props: {
  person: PublicUser;
  onSaved: (u: PublicUser) => void;
  onRemove: (u: PublicUser) => Promise<boolean>;
}) {
  const draft = signal<number[]>([]);
  const busy = signal(false);
  const removing = signal(false);
  const removeBusy = signal(false);
  // The person's saved sites start the draft, and each save starts it again from them.
  effect(() => {
    draft.set([...props.person.siteIds]);
  });
  const save = async (p: PublicUser) => {
    busy.set(true);
    try {
      const { user } = await api.updateUser(p.id, draft());
      props.onSaved(user);
      toast(`Saved ${user.email}'s sites`, { tone: "ok" });
    } catch (e) {
      toast("Couldn't save their sites", { body: e instanceof ApiError ? e.message : undefined, tone: "error" });
    } finally {
      busy.set(false);
    }
  };
  const remove = async () => {
    removeBusy.set(true);
    const gone = await props.onRemove(props.person);
    removeBusy.set(false);
    if (gone) {
      removing.set(false);
      closeDetail();
    }
  };
  const p = () => props.person;
  return (
    <View class="gap-5" testID="person-detail">
      <PropertyList
        items={[
          { label: "Role", value: <Tag label={isAdmin(p()) ? "Admin" : "Viewer"} tone={isAdmin(p()) ? "brand" : "neutral"} /> },
          { label: "Added", value: day(p().created_at), mono: true },
          { label: "Sites", value: sitesLabel(p()) },
        ]}
      />
      <View class="gap-2">
        <Heading size="lead">Sites</Heading>
        <If
          when={!isAdmin(p())}
          else={<Txt tone="muted">The administrator reads every site. That is set by ADMIN_EMAIL when the instance is deployed.</Txt>}
        >
          <SiteChecklist testID="person-sites" sites={siteList()} selected={draft()} onChange={(ids) => draft.set(ids)} disabled={busy()} />
          <View class="flex-row flex-wrap items-center gap-2 pt-2">
            <Button
              label="Save"
              variant="primary"
              busy={busy()}
              disabled={sameIds(draft(), p().siteIds)}
              onPress={() => void save(p())}
              testID="person-save"
            />
            <View class="flex-1" />
            <Button label="Remove access…" variant="danger" icon="trash" onPress={() => removing.set(true)} testID="person-remove" />
          </View>
        </If>
      </View>
      <ConfirmDialog
        testID="remove-person-dialog"
        open={removing()}
        title={`Remove ${p().email}?`}
        body="They can no longer sign in, and their sessions and connected agents end at once."
        confirmLabel="Remove"
        danger
        busy={removeBusy()}
        onConfirm={() => void remove()}
        onCancel={() => removing.set(false)}
      />
    </View>
  );
}

// ------------------------------------------------------------------------------------- screen

export function TeamScreen() {
  const people = resource(() => (isOwner() ? true : null), () => api.users());
  const inviting = signal(false);

  const list = () => people()?.users ?? [];
  const replace = (u: PublicUser) => people.mutate({ users: list().map((x) => (x.id === u.id ? u : x)) });

  /** Remove someone; true once they are gone. */
  const remove = async (p: PublicUser): Promise<boolean> => {
    try {
      await api.deleteUser(p.id);
      people.mutate({ users: list().filter((x) => x.id !== p.id) });
      toast(`Removed ${p.email}`, { body: "Their sessions and connected agents ended too.", tone: "ok" });
      return true;
    } catch (e) {
      toast("Couldn't remove them", { body: e instanceof ApiError ? e.message : undefined, tone: "error" });
      return false;
    }
  };

  // The page reads the person from the list, so a save shows at once; the row pressed stands in
  // once they have left it (the page is popping).
  const openPerson = (u: PublicUser) => {
    const id = u.id;
    const live = () => list().find((x) => x.id === id) ?? u;
    openDetail({
      testID: "person-page",
      title: () => live().email,
      meta: () => `${isAdmin(live()) ? "admin" : "viewer"} · #${id}`,
      content: () => <PersonDetail person={live()} onSaved={replace} onRemove={remove} />,
    });
  };

  return (
    <ScreenFrame
      testID="screen-team"
      title="Team"
      description="People who can sign in, and the sites each one reads."
      actions={
        <If when={isOwner()}>
          <Button label="Invite…" icon="userPlus" variant="primary" onPress={() => inviting.set(true)} testID="invite" />
        </If>
      }
    >
      <If when={isOwner()} else={<EmptyState icon="team" title="Only the administrator manages the team" />}>
        <If
          when={!people.error()}
          else={
            <EmptyState
              icon="error"
              title="Couldn't load the team"
              body={people.error() instanceof ApiError ? (people.error() as ApiError).message : undefined}
              action={{ label: "Try again", onPress: () => void people.refetch() }}
            />
          }
        >
          <Card inset testID="team-table">
            <If when={people()} else={<View class="gap-3 p-4"><Skeleton width="60%" /><Skeleton width="45%" /><Skeleton width="52%" /></View>}>
              <DataTable
                columns={[
                  {
                    key: "person",
                    title: "Person",
                    cell: (u: PublicUser) => (
                      <View class="min-w-0 flex-row items-center gap-2">
                        <Avatar name={u.email} size={22} />
                        <View class="min-w-0 shrink"><Txt size="table" truncate>{u.email}</Txt></View>
                        <If when={u.id === currentUser()?.id}><Tag label="You" /></If>
                      </View>
                    ),
                  },
                  { key: "role", title: "Role", width: 88, cell: (u: PublicUser) => <Tag label={isAdmin(u) ? "Admin" : "Viewer"} tone={isAdmin(u) ? "brand" : "neutral"} /> },
                  { key: "sites", title: "Sites", width: 150, hideBelow: 520, cell: (u: PublicUser) => sitesLabel(u) },
                  { key: "added", title: "Added", width: 96, align: "end", mono: true, hideBelow: 640, cell: (u: PublicUser) => ago(u.created_at) },
                ]}
                rows={list()}
                rowKey={(u) => u.id}
                rowLabel={(u) => `Open ${u.email}`}
                onRowPress={openPerson}
              />
            </If>
          </Card>
          <If when={people() && list().length <= 1}>
            <EmptyState
              icon="userPlus"
              title="No one else yet"
              body={`Invite an email. Nothing is mailed: tell them to sign in at ${currentServer() || "this instance"} with a code.`}
              action={{ label: "Invite…", onPress: () => inviting.set(true) }}
              testID="team-empty"
            />
          </If>
        </If>
      </If>

      <InviteDialog
        open={inviting()}
        onClose={() => inviting.set(false)}
        onInvited={(u) => {
          inviting.set(false);
          people.mutate({ users: [...list(), u] });
          toast(`Invited ${u.email}`, { body: `No email is sent: tell them to sign in at ${currentServer() || "this instance"}.`, tone: "ok" });
        }}
      />
    </ScreenFrame>
  );
}

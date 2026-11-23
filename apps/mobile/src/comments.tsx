import React, { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Pressable, Text, TextInput, View } from "react-native";
import { ApiError, COMMENT_MAX, NetworkError, type PendingComment } from "@rsb/photo-sync";
import { useApp, useCommentsVersion } from "./state";
import { PersonBadge } from "./photos";
import { Button, C, s } from "./ui";

/** A comment as the server sends it (see the API's PhotoComment). */
interface ServerComment {
  id: string;
  parentId: string | null;
  authorId: string;
  author: string;
  authorAvatarAt: string | null;
  body: string | null;
  mentions: { id: string; name: string }[];
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
  deletedBy: string | null;
  mine: boolean;
  canEdit: boolean;
  canDelete: boolean;
}
interface Person { id: string; name: string; avatarAt: string | null; me: boolean }
type ReplyTo = { serverId: string | null; localId: string | null; name: string } | null;

const when = (iso: string) => new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const mentionsIn = (body: string, picked: Person[]) => [...new Set(picked.filter((p) => body.includes(`@${p.name}`)).map((p) => p.id))];

/**
 * Comments on one photo, on the photo screen. Works offline: new comments and replies wait on the phone (encrypted)
 * and are sent by the sync queue. The last list seen is kept (encrypted) so comments can be read without signal.
 * Editing and deleting need a connection.
 */
export function PhotoComments({ jobId, serverId, localId }: { jobId: string; serverId: string | null; localId: string | null }) {
  const app = useApp();
  useCommentsVersion();
  const orgId = app.session?.orgId ?? "";
  const canComment = app.can("photo_comments.create");
  const [items, setItems] = useState<ServerComment[] | null>(null);
  const [offline, setOffline] = useState(false);
  const [people, setPeople] = useState<Person[]>([]);
  const [picked, setPicked] = useState<Person[]>([]);
  const [body, setBody] = useState("");
  const [replyTo, setReplyTo] = useState<ReplyTo>(null);
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [showPeople, setShowPeople] = useState(false);
  const input = useRef<React.ComponentRef<typeof TextInput>>(null);

  const pending = app.comments.forPhoto({ serverId, localId });
  const pendingCount = pending.length;

  const load = useCallback(async () => {
    if (!serverId) return;
    const key = `comments-${serverId}`;
    try {
      const r = await app.api.get<{ items: ServerComment[] }>(`/v1/orgs/${orgId}/photos/${serverId}/comments`);
      setItems(r.items);
      setOffline(false);
      await app.cache.put(key, r.items);
    } catch {
      setOffline(true);
      setItems((cur) => cur);
      const cached = await app.cache.get<ServerComment[]>(key);
      if (cached) setItems((cur) => cur ?? cached);
    }
  }, [app.api, app.cache, orgId, serverId]);

  useEffect(() => { void load(); }, [load]);
  // When a waiting comment has been sent, show the server's copy.
  const lastPending = useRef(pendingCount);
  useEffect(() => {
    if (pendingCount < lastPending.current) void load();
    lastPending.current = pendingCount;
  }, [pendingCount, load]);

  useEffect(() => {
    if (!canComment) return;
    const key = `people-${jobId}`;
    void app.api.get<{ items: Person[] }>(`/v1/orgs/${orgId}/jobs/${jobId}/people`)
      .then(async (r) => { setPeople(r.items); await app.cache.put(key, r.items); })
      .catch(async () => setPeople((await app.cache.get<Person[]>(key)) ?? []));
  }, [app.api, app.cache, canComment, jobId, orgId]);

  const mention = (p: Person) => {
    setPicked((cur) => (cur.some((x) => x.id === p.id) ? cur : [...cur, p]));
    setBody((b) => `${b}${b && !b.endsWith(" ") ? " " : ""}@${p.name} `);
    setShowPeople(false);
    input.current?.focus();
  };

  const send = async () => {
    const text = body.trim();
    if (!text) return;
    setBusy(true);
    try {
      await app.comments.add({
        orgId, jobId, photoServerId: serverId, photoLocalId: serverId ? null : localId,
        parentId: replyTo?.serverId ?? null, parentLocalId: replyTo?.serverId ? null : replyTo?.localId ?? null,
        body: text, mentionIds: mentionsIn(text, picked),
      });
      setBody("");
      setPicked([]);
      setReplyTo(null);
      app.syncNow();
    } catch (e) {
      Alert.alert("Not saved", e instanceof Error ? e.message : "Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const online = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await load();
      return true;
    } catch (e) {
      Alert.alert(
        "Not saved",
        e instanceof NetworkError ? "Editing and deleting comments needs a connection. Try again when you have signal."
          : e instanceof ApiError ? e.message : "Please try again.",
      );
      return false;
    } finally {
      setBusy(false);
    }
  };

  const saveEdit = async () => {
    if (!editing) return;
    const text = editing.body.trim();
    if (!text) return;
    const ok = await online(() => app.api.patch(`/v1/orgs/${orgId}/photo-comments/${editing.id}`, { body: text, mentionIds: mentionsIn(text, [...picked, ...people]) }));
    if (ok) setEditing(null);
  };

  const remove = (c: ServerComment) =>
    Alert.alert("Delete this comment?", "It will show as \"Comment deleted\".", [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: () => void online(() => app.api.delete(`/v1/orgs/${orgId}/photo-comments/${c.id}`)) },
    ]);

  const tops = (items ?? []).filter((c) => !c.parentId);
  const replies = (id: string) => (items ?? []).filter((c) => c.parentId === id);
  const pendingTops = pending.filter((p) => !p.parentId && !p.parentLocalId);
  const pendingReplies = (serverParent: string | null, localParent: string | null) =>
    pending.filter((p) => (serverParent && p.parentId === serverParent) || (localParent && p.parentLocalId === localParent));
  const live = (items ?? []).filter((c) => !c.deletedAt).length + pendingCount;

  const serverRow = (c: ServerComment, isReply: boolean) => (
    <View key={c.id} style={{ flexDirection: "row", gap: 8, marginLeft: isReply ? 30 : 0 }}>
      <PersonBadge personKey={c.mine ? "me" : c.authorId} name={c.author} personId={c.authorId} avatarAt={c.authorAvatarAt} />
      <View style={{ flex: 1 }}>
        <Text style={{ color: C.text, fontWeight: "600" }}>
          {c.author}{c.mine ? " (you)" : ""} <Text style={[s.muted, { fontWeight: "400" }]}>{when(c.createdAt)}{c.editedAt && !c.deletedAt ? " · edited" : ""}</Text>
        </Text>
        {c.deletedAt ? (
          <Text style={[s.muted, { fontStyle: "italic" }]}>Comment deleted{c.deletedBy ? ` by ${c.deletedBy}` : ""}</Text>
        ) : editing?.id === c.id ? (
          <View style={{ gap: 6 }}>
            <TextInput style={[s.input, { minHeight: 60, paddingTop: 10, textAlignVertical: "top" }]} multiline maxLength={COMMENT_MAX} value={editing.body} onChangeText={(t) => setEditing({ id: c.id, body: t })} />
            <View style={{ flexDirection: "row", gap: 8 }}>
              <Button title="Cancel" kind="secondary" style={{ flex: 1 }} onPress={() => setEditing(null)} />
              <Button title="Save" style={{ flex: 1 }} busy={busy} onPress={() => void saveEdit()} />
            </View>
          </View>
        ) : (
          <Text style={{ color: C.text }}>{c.body}</Text>
        )}
        {!c.deletedAt && editing?.id !== c.id ? (
          <View style={{ flexDirection: "row", gap: 16, marginTop: 2 }}>
            {!isReply && canComment ? <Link label="Reply" onPress={() => { setReplyTo({ serverId: c.id, localId: null, name: c.author }); input.current?.focus(); }} /> : null}
            {c.canEdit ? <Link label="Edit" onPress={() => setEditing({ id: c.id, body: c.body ?? "" })} /> : null}
            {c.canDelete ? <Link label="Delete" danger onPress={() => remove(c)} /> : null}
          </View>
        ) : null}
      </View>
    </View>
  );

  const pendingRow = (p: PendingComment, isReply: boolean) => (
    <View key={p.localId} style={{ flexDirection: "row", gap: 8, marginLeft: isReply ? 30 : 0, opacity: 0.85 }}>
      <PersonBadge personKey="me" name={app.session?.displayName ?? null} personId={app.session?.membershipId ?? null} avatarAt={app.session?.avatarAt ?? null} />
      <View style={{ flex: 1 }}>
        <Text style={{ color: C.text, fontWeight: "600" }}>
          You <Text style={[s.muted, { fontWeight: "400" }]}>{p.needsAttention ? "· not sent" : "· waiting to send"}</Text>
        </Text>
        <Text style={{ color: C.text }}>{p.body}</Text>
        {p.needsAttention ? (
          <>
            <Text style={s.error}>{p.lastError}</Text>
            <View style={{ flexDirection: "row", gap: 16, marginTop: 2 }}>
              <Link label="Try again" onPress={() => { void app.comments.retry(p.localId).then(() => app.syncNow()); }} />
              <Link label="Discard" danger onPress={() => Alert.alert("Discard this comment?", "It hasn't been sent and will be removed from this phone.", [
                { text: "Keep", style: "cancel" },
                { text: "Discard", style: "destructive", onPress: () => void app.comments.discard(p.localId) },
              ])} />
            </View>
          </>
        ) : !isReply && canComment ? (
          <View style={{ flexDirection: "row", marginTop: 2 }}>
            <Link label="Reply" onPress={() => { setReplyTo({ serverId: null, localId: p.localId, name: "your comment" }); input.current?.focus(); }} />
          </View>
        ) : null}
      </View>
    </View>
  );

  return (
    <View style={[s.card, { gap: 12 }]}>
      <Text style={s.label}>Comments{live ? ` (${live})` : ""}</Text>
      {serverId && items === null && !offline ? <Text style={s.muted}>Loading comments…</Text> : null}
      {offline ? <Text style={s.muted}>No connection. Showing the comments last seen on this phone.</Text> : null}
      {!serverId ? <Text style={s.muted}>This photo hasn't uploaded yet. Comments you write here are sent right after it.</Text> : null}
      {tops.map((c) => (
        <View key={c.id} style={{ gap: 8 }}>
          {serverRow(c, false)}
          {replies(c.id).map((r) => serverRow(r, true))}
          {pendingReplies(c.id, null).map((p) => pendingRow(p, true))}
        </View>
      ))}
      {pendingTops.map((p) => (
        <View key={p.localId} style={{ gap: 8 }}>
          {pendingRow(p, false)}
          {pendingReplies(null, p.localId).map((r) => pendingRow(r, true))}
        </View>
      ))}
      {items && !tops.length && !pendingTops.length ? <Text style={s.muted}>No comments yet.</Text> : null}

      {canComment ? (
        <View style={{ gap: 8 }}>
          {replyTo ? (
            <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
              <Text style={s.muted}>Replying to {replyTo.name}</Text>
              <Link label="Cancel" onPress={() => setReplyTo(null)} />
            </View>
          ) : null}
          <TextInput
            ref={input}
            style={[s.input, { minHeight: 60, paddingTop: 10, textAlignVertical: "top" }]}
            multiline
            maxLength={COMMENT_MAX}
            value={body}
            onChangeText={setBody}
            placeholder={replyTo ? "Write a reply" : "Write a comment"}
            placeholderTextColor={C.muted}
            accessibilityLabel={replyTo ? "Write a reply" : "Write a comment"}
          />
          {showPeople ? (
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              {people.filter((p) => !p.me).map((p) => (
                <Pressable key={p.id} onPress={() => mention(p)} accessibilityRole="button" accessibilityLabel={`Mention ${p.name}`}
                  style={{ flexDirection: "row", alignItems: "center", gap: 6, borderWidth: 1, borderColor: C.line, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 6 }}>
                  <PersonBadge personKey={p.id} name={p.name} personId={p.id} avatarAt={p.avatarAt} size={18} />
                  <Text style={{ color: C.text }}>{p.name}</Text>
                </Pressable>
              ))}
              {!people.some((p) => !p.me) ? <Text style={s.muted}>No one else is on this job.</Text> : null}
            </View>
          ) : null}
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Button title="@ Mention" kind="secondary" style={{ flex: 1 }} onPress={() => setShowPeople((v) => !v)} />
            <Button title={replyTo ? "Send reply" : "Send"} style={{ flex: 1 }} busy={busy} disabled={!body.trim()} onPress={() => void send()} />
          </View>
        </View>
      ) : null}
    </View>
  );
}

function Link({ label, onPress, danger }: { label: string; onPress: () => void; danger?: boolean }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" hitSlop={8}>
      <Text style={{ color: danger ? C.flag : C.brand, fontWeight: "600" }}>{label}</Text>
    </Pressable>
  );
}

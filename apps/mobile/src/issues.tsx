import React, { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { router, useFocusEffect } from "expo-router";
import * as Crypto from "expo-crypto";
import { ApiError, ISSUE_EVENT_LABEL, type PendingAction, ISSUE_STATUS_LABEL, NetworkError, issueStatusText, type IssueStatus } from "@rsb/photo-sync";
import { useActionsVersion, useApp, useQueueVersion } from "./state";
import { LocalImage, ServerImage, type ServerPhoto } from "./photos";
import { importFromLibrary } from "./importPhotos";
import { Button, C, s } from "./ui";

/** An issue as the server sends it (see the API's PhotoIssue). */
export interface ServerIssue {
  id: string;
  jobId: string;
  jobNumber: string;
  photoId: string;
  photoDeleted: boolean;
  markupId: string | null;
  title: string;
  details: string | null;
  status: IssueStatus;
  assigneeId: string | null;
  assignee: string | null;
  createdById: string;
  createdBy: string;
  submittedBy: string | null;
  resolvedBy: string | null;
  createdAt: string;
  updatedAt: string;
  lastEvent: string;
  fixPhotoIds: string[];
  /** Stage of each fix photo, same order. Missing from older servers. */
  fixPhotoStages?: string[];
  can: { assign: boolean; start: boolean; submit: boolean; approve: boolean; sendBack: boolean; reopen: boolean; edit: boolean };
}
interface IssueEvent { id: string; kind: string; actor: string; fromStatus: IssueStatus | null; toStatus: IssueStatus | null; note: string | null; assignee: string | null; createdAt: string }
interface Person { id: string; name: string; me: boolean }
type MarkRef = { id: string; name: string };

const when = (iso: string) => new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const TONE: Record<IssueStatus, string> = { open: "#b45309", in_progress: "#a16207", awaiting_review: "#2563eb", resolved: "#15803d" };

function problem(e: unknown): string {
  if (e instanceof NetworkError) return "No connection. Try again when you have signal.";
  if (e instanceof ApiError) return e.message;
  return "Please try again.";
}

/** Open the photo an issue is about. Refreshes the job's photo list first so the photo screen can find it. */
export async function openIssuePhoto(app: ReturnType<typeof useApp>, jobId: string, photoId: string): Promise<void> {
  const key = `photos-${jobId}`;
  try {
    const r = await app.api.get<{ items: ServerPhoto[] }>(`/v1/orgs/${app.session!.orgId}/jobs/${jobId}/photos`);
    await app.cache.put(key, r.items);
    if (!r.items.some((p) => p.id === photoId)) return Alert.alert("Photo not found", "That photo was deleted. An owner or manager can restore it from Recently Deleted.");
  } catch {
    const cached = await app.cache.get<ServerPhoto[]>(key);
    if (!cached?.some((p) => p.id === photoId)) return Alert.alert("Needs a connection", "Open this job once with signal, then try again.");
  }
  router.push({ pathname: "/photo/[key]", params: { key: `s:${photoId}`, jobId } });
}

/** Pick one person on the job (an Alert list). */
function pickPerson(people: Person[], title: string, onPick: (id: string | null) => void, allowNone: boolean) {
  Alert.alert(title, undefined, [
    ...people.map((p) => ({ text: `${p.name}${p.me ? " (me)" : ""}`, onPress: () => onPick(p.id) })),
    ...(allowNone ? [{ text: "Nobody yet", onPress: () => onPick(null) }] : []),
    { text: "Cancel", style: "cancel" as const },
  ]);
}

function useJobPeople(jobId: string, enabled: boolean): Person[] {
  const app = useApp();
  const [people, setPeople] = useState<Person[]>([]);
  useEffect(() => {
    if (!enabled) return;
    void app.api.get<{ items: Person[] }>(`/v1/orgs/${app.session!.orgId}/jobs/${jobId}/people`).then((r) => setPeople(r.items)).catch(() => undefined);
  }, [app.api, app.session, jobId, enabled]);
  return people;
}

export function IssueStatusPill({ issue }: { issue: Pick<ServerIssue, "status" | "lastEvent"> }) {
  const sentBack = issue.status === "open" && issue.lastEvent === "sent_back";
  const bg = sentBack ? C.flag : TONE[issue.status];
  return (
    <View style={{ backgroundColor: bg, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 }}>
      <Text style={{ color: "#fff", fontSize: 12, fontWeight: "700" }}>{issueStatusText(issue)}</Text>
    </View>
  );
}

type Mode = null | "submit" | "approve" | "send_back" | "reopen";
const ACTION_LABEL: Record<string, string> = { start: "Start", submit: "Send fix for review", approve: "Approve fix", send_back: "Send back", reopen: "Reopen", assign: "Assign" };

/** A drawing or issue change saved on this phone with no signal: waiting, or refused (with Try again / Discard). */
export function WaitingChange({ a, what }: { a: PendingAction; what: string }) {
  const app = useApp();
  return (
    <View style={{ gap: 6, padding: 10, borderRadius: 8, borderWidth: 1, borderColor: a.needsAttention ? C.flag : C.line }}>
      <Text style={{ color: a.needsAttention ? C.flag : C.text, fontWeight: "600" }}>
        {a.needsAttention ? `⚠️ ${what} wasn't saved` : `⏳ ${what}: waiting for signal`}
      </Text>
      <Text style={s.muted}>{a.needsAttention && a.lastError ? a.lastError : "Kept on this phone and sent automatically."}</Text>
      {a.needsAttention ? (
        <View style={{ flexDirection: "row", gap: 8 }}>
          <Button title="Try again" kind="secondary" style={{ flex: 1 }} onPress={() => { void app.actions.retry(a.localId).then(() => app.syncNow()); }} />
          <Button title="Discard" kind="danger" style={{ flex: 1 }} onPress={() => Alert.alert("Throw this away?", "It was never saved on the server.", [
            { text: "Keep it", style: "cancel" },
            { text: "Throw away", style: "destructive", onPress: () => void app.actions.discard(a.localId) },
          ])} />
        </View>
      ) : null}
    </View>
  );
}

type Slot = { localId: string | null; serverId: string | null };
/** The photo's id on the server once it has uploaded (null while it's still on its way). */
function slotServerId(app: ReturnType<typeof useApp>, slot: Slot | null): string | null {
  if (!slot) return null;
  if (slot.serverId) return slot.serverId;
  const q = slot.localId ? app.queue.get(slot.localId) : undefined;
  return q?.serverId && q.stored ? q.serverId : null;
}

/** One of the two boxes on "Send fix for review". Empty: a dashed box to tap. Filled: the photo (uploading or uploaded). */
function FixBox({ label, hint, slot, serverId, onPress }: { label: string; hint: string; slot: Slot | null; serverId: string | null; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`${label} photo${slot ? "" : `, ${hint.toLowerCase()}. Tap to add`}`}
      style={{ flex: 1, aspectRatio: 1, borderRadius: 10, overflow: "hidden", alignItems: "center", justifyContent: "center",
        borderWidth: slot ? 0 : 2, borderStyle: "dashed", borderColor: C.muted, backgroundColor: slot ? C.line : "transparent" }}>
      {serverId ? <ServerImage photoId={serverId} style={{ width: "100%", height: "100%" }} thumb />
        : slot?.localId ? <LocalImage localId={slot.localId} which="thumbnail" style={{ width: "100%", height: "100%" }} />
        : <View style={{ alignItems: "center", gap: 4 }}><Text style={{ fontSize: 28, color: C.muted }}>＋</Text><Text style={[s.muted, { fontSize: 12 }]}>{hint}</Text></View>}
      <Text style={{ position: "absolute", top: 6, left: 6, color: "#fff", fontSize: 12, fontWeight: "800", backgroundColor: "rgba(0,0,0,0.55)", paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, overflow: "hidden" }}>{label}</Text>
      {slot && !serverId ? <Text style={{ position: "absolute", bottom: 6, left: 6, right: 6, textAlign: "center", color: "#fff", fontSize: 11, fontWeight: "700", backgroundColor: "rgba(0,0,0,0.55)", borderRadius: 6, overflow: "hidden", paddingVertical: 2 }}>Uploading…</Text> : null}
    </Pressable>
  );
}

/** The problem photo next to the fix photo(s), so the fix can be checked at a glance. Tapping one opens it. */
function BeforeAfter({ app, jobId, beforeId, afterIds, onRemoveAfter, emptyAfter = "No after photo" }: {
  app: ReturnType<typeof useApp>; jobId: string; beforeId: string | null; afterIds: string[]; onRemoveAfter?: (id: string) => void; emptyAfter?: string;
}) {
  const box = { flex: 1, aspectRatio: 1, borderRadius: 8, overflow: "hidden" as const, backgroundColor: C.line };
  const tag = (t: string) => (
    <Text style={{ position: "absolute", top: 6, left: 6, color: "#fff", fontSize: 12, fontWeight: "800", backgroundColor: "rgba(0,0,0,0.55)", paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, overflow: "hidden" }}>{t}</Text>
  );
  const [first, ...more] = afterIds;
  return (
    <View style={{ gap: 6 }}>
      <View style={{ flexDirection: "row", gap: 8 }}>
        <Pressable style={box} disabled={!beforeId} onPress={() => beforeId && void openIssuePhoto(app, jobId, beforeId)} accessibilityRole="button" accessibilityLabel="Before: the problem photo">
          {beforeId ? <ServerImage photoId={beforeId} style={{ width: "100%", height: "100%" }} thumb /> : <Text style={[s.muted, { margin: 8 }]}>Photo deleted</Text>}
          {tag("BEFORE")}
        </Pressable>
        <Pressable style={[box, first ? null : { alignItems: "center", justifyContent: "center", borderWidth: 2, borderStyle: "dashed", borderColor: C.muted, backgroundColor: "transparent" }]}
          disabled={!first} onPress={() => first && void openIssuePhoto(app, jobId, first)} accessibilityRole="button" accessibilityLabel={first ? "After: the fix photo" : emptyAfter}>
          {first ? <ServerImage photoId={first} style={{ width: "100%", height: "100%" }} thumb /> : <Text style={[s.muted, { textAlign: "center", padding: 8 }]}>{emptyAfter}</Text>}
          {tag("AFTER")}
          {first && onRemoveAfter ? (
            <Pressable onPress={() => onRemoveAfter(first)} hitSlop={8} accessibilityRole="button" accessibilityLabel="Remove this after photo"
              style={{ position: "absolute", top: 6, right: 6, width: 26, height: 26, borderRadius: 13, backgroundColor: "rgba(0,0,0,0.6)", alignItems: "center", justifyContent: "center" }}>
              <Text style={{ color: "#fff", fontWeight: "800" }}>✕</Text>
            </Pressable>
          ) : null}
        </Pressable>
      </View>
      {more.length ? (
        <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          <Text style={s.muted}>Also:</Text>
          {more.map((id) => (
            <Pressable key={id} onPress={() => (onRemoveAfter ? onRemoveAfter(id) : void openIssuePhoto(app, jobId, id))} accessibilityRole="button"
              accessibilityLabel={onRemoveAfter ? "Remove this after photo" : "Open this after photo"}>
              <ServerImage photoId={id} style={{ width: 48, height: 48, borderRadius: 6 }} thumb />
              {onRemoveAfter ? <Text style={{ position: "absolute", top: 0, right: 2, color: "#fff", fontWeight: "800", textShadowColor: "#000", textShadowRadius: 3 }}>✕</Text> : null}
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
}

/** One issue and the buttons the viewer may use. Changing an issue needs a connection for now. */
export function IssueCard({ issue, onChanged, markName, onShowMark, showPhotoLink }: {
  issue: ServerIssue; onChanged: () => void; markName?: string | null; onShowMark?: () => void; showPhotoLink?: boolean;
}) {
  const app = useApp();
  useActionsVersion();
  const i = issue;
  const orgId = app.session?.orgId ?? "";
  const waiting = app.actions.forIssue(i.id);
  const [mode, setMode] = useState<Mode>(null);
  const [note, setNote] = useState("");
  const [fixes, setFixes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<IssueEvent[] | null>(null);
  // "Send fix for review": a Before box (optional) and an After box (needed). Each holds one photo, which may still be uploading.
  const [before, setBefore] = useState<Slot | null>(null);
  const [after, setAfter] = useState<Slot | null>(null);
  const cameraFor = useRef<{ stage: "before" | "after"; since: string } | null>(null);
  useQueueVersion(); // re-check uploads as they finish
  const people = useJobPeople(i.jobId, i.can.assign);

  const act = async (body: { action: string; note?: string | null; assigneeId?: string | null; fixPhotoIds?: string[] }) => {
    setBusy(true);
    // Made once, so if this is sent again later (no signal now) the server applies it only once.
    const full = { clientRef: Crypto.randomUUID(), expectedStatus: i.status, ...body };
    const done = () => { setMode(null); setNote(""); setBefore(null); setAfter(null); setHistory(null); };
    try {
      await app.api.post(`/v1/orgs/${orgId}/photo-issues/${i.id}/actions`, full);
      done();
      onChanged();
    } catch (e) {
      if (e instanceof NetworkError) {
        // No signal: keep it on the phone and send it later. If the issue changes meanwhile, nothing is changed and the phone says so.
        try {
          await app.actions.add({ orgId, jobId: i.jobId, photoId: i.photoId, kind: "issue_action", issueId: i.id, body: full, label: ACTION_LABEL[body.action] ?? body.action });
          done();
          Alert.alert("Saved on this phone", "No signal right now. It will be sent automatically. If someone changes this issue first, nothing is changed and you'll see why here.");
        } catch (err) {
          Alert.alert("Not saved", err instanceof Error ? err.message : "Please try again.");
        }
        return;
      }
      Alert.alert("Not saved", problem(e));
      if (e instanceof ApiError && e.status === 409) onChanged();
    } finally {
      setBusy(false);
    }
  };
  const startSubmit = () => setMode("submit");
  const setSlot = (stage: "before" | "after", v: Slot | null) => (stage === "before" ? setBefore(v) : setAfter(v));
  // Back from the camera: the newest photo taken there for this box goes in it.
  useFocusEffect(useCallback(() => {
    const c = cameraFor.current;
    if (!c) return;
    cameraFor.current = null;
    const taken = app.queue.forJob(i.jobId).filter((q) => q.stage === c.stage && q.capturedAt >= c.since);
    const newest = taken[taken.length - 1];
    if (newest) setSlot(c.stage, { localId: newest.localId, serverId: null });
  }, [app, i.jobId])); // eslint-disable-line react-hooks/exhaustive-deps
  const chooseFor = (stage: "before" | "after") => {
    const filled = stage === "before" ? before : after;
    const label = stage === "before" ? "Before" : "After";
    Alert.alert(`${label} photo`, stage === "after" ? "A photo showing the finished fix." : "Optional: a photo from before you fixed it.", [
      { text: "Take photo", onPress: () => {
        cameraFor.current = { stage, since: new Date(Date.now() - 2000).toISOString() };
        router.push({ pathname: "/jobs/[jobId]/camera", params: { jobId: i.jobId, jobNumber: i.jobNumber, stage } });
      } },
      { text: "Choose from library", onPress: () => {
        void importFromLibrary(app, { jobId: i.jobId, jobNumber: i.jobNumber }, stage, { single: true, onAdded: (localId) => setSlot(stage, { localId, serverId: null }) });
      } },
      ...(filled ? [{ text: "Remove", style: "destructive" as const, onPress: () => setSlot(stage, null) }] : []),
      { text: "Cancel", style: "cancel" as const },
    ]);
  };
  const beforeId = slotServerId(app, before);
  const afterId = slotServerId(app, after);
  const waitingUpload = (!!before && !beforeId) || (!!after && !afterId);
  // Remember the server id once it's known (the phone forgets uploaded photos' details after a while).
  useEffect(() => { if (before && !before.serverId && beforeId) setBefore({ ...before, serverId: beforeId }); }, [before, beforeId]);
  useEffect(() => { if (after && !after.serverId && afterId) setAfter({ ...after, serverId: afterId }); }, [after, afterId]);
  const loadHistory = async () => {
    if (history) return setHistory(null);
    try {
      const r = await app.api.get<{ history: IssueEvent[] }>(`/v1/orgs/${orgId}/photo-issues/${i.id}`);
      setHistory(r.history);
    } catch (e) {
      Alert.alert("History not loaded", problem(e));
    }
  };

  return (
    <View style={[s.card, { gap: 6, borderLeftWidth: 4, borderLeftColor: TONE[i.status] }]} accessibilityLabel={`Issue: ${i.title}, ${issueStatusText(i)}`}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text style={{ flex: 1, fontWeight: "700", color: C.text, fontSize: 16 }}>🔧 {i.title}</Text>
        <IssueStatusPill issue={i} />
      </View>
      {i.details ? <Text style={{ color: C.text }}>{i.details}</Text> : null}
      <Text style={s.muted}>
        {i.assignee ? `Assigned to ${i.assignee}` : "Not assigned yet"} · reported by {i.createdBy}, {when(i.createdAt)}
        {i.status === "awaiting_review" && i.submittedBy ? ` · fix sent by ${i.submittedBy}` : ""}
        {i.status === "resolved" && i.resolvedBy ? ` · approved by ${i.resolvedBy}` : ""}
      </Text>
      {markName !== undefined && i.markupId ? (
        markName ? (
          <Pressable onPress={onShowMark} hitSlop={6}><Text style={{ color: C.link }}>📍 About the {markName}</Text></Pressable>
        ) : <Text style={s.muted}>📍 About a mark that was removed</Text>
      ) : null}
      {showPhotoLink ? (
        i.photoDeleted ? <Text style={s.muted}>The photo was deleted.</Text> : (
          <Pressable onPress={() => void openIssuePhoto(app, i.jobId, i.photoId)} hitSlop={6}><Text style={{ color: C.link, fontWeight: "600" }}>Open the photo ›</Text></Pressable>
        )
      ) : null}
      {i.fixPhotoIds.length && mode !== "submit" ? (
        <BeforeAfter app={app} jobId={i.jobId}
          beforeId={i.fixPhotoIds.find((_, n) => i.fixPhotoStages?.[n] === "before") ?? (i.photoDeleted ? null : i.photoId)}
          afterIds={i.fixPhotoIds.filter((_, n) => i.fixPhotoStages?.[n] !== "before")} />
      ) : null}

      {waiting.map((a) => <WaitingChange key={a.localId} a={a} what={a.label} />)}
      {waiting.length ? null : mode === null ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {i.can.start ? <Button title="Start" kind="secondary" busy={busy} onPress={() => void act({ action: "start" })} /> : null}
          {i.can.submit ? <Button title="Send fix for review" onPress={() => void startSubmit()} /> : null}
          {i.can.approve ? <Button title="Approve" onPress={() => setMode("approve")} /> : null}
          {i.can.sendBack ? <Button title="Send back" kind="secondary" onPress={() => setMode("send_back")} /> : null}
          {i.can.reopen ? <Button title="Reopen" kind="secondary" onPress={() => setMode("reopen")} /> : null}
          {i.can.assign ? (
            <Button title={i.assigneeId ? "Reassign" : "Assign"} kind="secondary" busy={busy}
              onPress={() => (people.length ? pickPerson(people, "Who should fix it?", (id) => void act({ action: "assign", assigneeId: id }), !!i.assigneeId) : Alert.alert("Needs a connection", "The people on this job couldn't be loaded."))} />
          ) : null}
        </View>
      ) : (
        <View style={{ gap: 8 }}>
          {mode === "submit" ? (
            <>
              <View style={{ flexDirection: "row", gap: 8 }}>
                <FixBox label="BEFORE" hint="Optional" slot={before} serverId={beforeId} onPress={() => chooseFor("before")} />
                <FixBox label="AFTER" hint="Needed" slot={after} serverId={afterId} onPress={() => chooseFor("after")} />
              </View>
              <Text style={s.muted}>Tap a box to take a photo or choose one from your library. The After photo is needed.</Text>
            </>
          ) : null}
          <TextInput style={[s.input, { minHeight: 60, textAlignVertical: "top" }]} multiline maxLength={2000} value={note} onChangeText={setNote} placeholderTextColor={C.muted}
            placeholder={mode === "send_back" ? "What still needs fixing? (needed)" : mode === "submit" ? "What did you do? (optional)" : "Note (optional)"} />
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Button title="Cancel" kind="secondary" style={{ flex: 1 }} onPress={() => setMode(null)} />
            <Button
              style={{ flex: 1 }}
              busy={busy}
              disabled={(mode === "send_back" && !note.trim()) || (mode === "submit" && (!afterId || waitingUpload))}
              title={mode === "submit" ? (!after ? "Add an After photo" : waitingUpload ? "Waiting for upload…" : "Send for review") : mode === "approve" ? "Approve fix" : mode === "send_back" ? "Send back" : "Reopen"}
              onPress={() => void act({ action: mode, note: note.trim() || null, ...(mode === "submit" ? { fixPhotoIds: [afterId, beforeId].filter((x): x is string => !!x) } : {}) })}
            />
          </View>
        </View>
      )}
      <Pressable onPress={() => void loadHistory()} hitSlop={6}><Text style={{ color: C.link }}>{history ? "Hide history" : "History"}</Text></Pressable>
      {history ? (
        <View style={{ gap: 4 }}>
          {history.map((e) => (
            <Text key={e.id} style={{ color: C.text, fontSize: 13 }}>
              <Text style={{ fontWeight: "700" }}>{e.actor}</Text> {ISSUE_EVENT_LABEL[e.kind] ?? e.kind}
              {e.kind === "assigned" && e.assignee ? ` to ${e.assignee}` : ""}
              {e.toStatus && e.fromStatus && e.toStatus !== e.fromStatus ? ` (${ISSUE_STATUS_LABEL[e.toStatus]})` : ""}
              <Text style={s.muted}> · {when(e.createdAt)}</Text>
              {e.note ? `\n“${e.note}”` : ""}
            </Text>
          ))}
        </View>
      ) : null}
    </View>
  );
}

/** Issues on one photo, on the photo screen, with "Report issue". */
export function PhotoIssues({ jobId, serverId, marks = [], aboutMark = null, onShowMark }: {
  jobId: string; serverId: string | null; marks?: MarkRef[]; aboutMark?: MarkRef | null; onShowMark?: (id: string) => void;
}) {
  const app = useApp();
  useActionsVersion();
  const orgId = app.session?.orgId ?? "";
  const canReport = app.can("photo_issues.create");
  const waitingReports = app.actions.forPhoto(serverId, "issue_report");
  const canManage = app.can("photo_issues.manage");
  const [items, setItems] = useState<ServerIssue[] | null>(null);
  const [offline, setOffline] = useState(false);
  const [reporting, setReporting] = useState(false);
  const [title, setTitle] = useState("");
  const [details, setDetails] = useState("");
  const [assignee, setAssignee] = useState<Person | null>(null);
  const [busy, setBusy] = useState(false);
  const [ref, setRef] = useState(() => Crypto.randomUUID());
  const people = useJobPeople(jobId, canManage && reporting);

  const load = useCallback(async () => {
    if (!serverId) return;
    const key = `issues-${serverId}`;
    try {
      const r = await app.api.get<{ items: ServerIssue[] }>(`/v1/orgs/${orgId}/photos/${serverId}/issues`);
      setItems(r.items);
      setOffline(false);
      await app.cache.put(key, r.items);
    } catch {
      setOffline(true);
      const cached = await app.cache.get<ServerIssue[]>(key);
      if (cached) setItems((cur) => cur ?? cached);
    }
  }, [app.api, app.cache, orgId, serverId]);
  useEffect(() => { void load(); }, [load]);
  // Once a waiting report or change has been sent, show the server's copy.
  const waitingCount = waitingReports.length + app.actions.forPhoto(serverId, "issue_action").length;
  const lastWaiting = useRef(waitingCount);
  useEffect(() => {
    if (waitingCount < lastWaiting.current) void load();
    lastWaiting.current = waitingCount;
  }, [waitingCount, load]);

  const report = async () => {
    if (!serverId || !title.trim()) return;
    setBusy(true);
    try {
      await app.api.post(`/v1/orgs/${orgId}/photos/${serverId}/issues`, {
        clientRef: ref, title: title.trim(), details: details.trim() || null, markupId: aboutMark?.id ?? null,
        ...(canManage && assignee ? { assigneeId: assignee.id } : {}),
      });
      setReporting(false);
      setTitle("");
      setDetails("");
      setAssignee(null);
      setRef(Crypto.randomUUID());
      await load();
    } catch (e) {
      if (e instanceof NetworkError) {
        try {
          await app.actions.add({
            orgId, jobId, photoId: serverId, kind: "issue_report", label: `Issue “${title.trim()}”`,
            body: { clientRef: ref, title: title.trim(), details: details.trim() || null, markupId: aboutMark?.id ?? null, ...(canManage && assignee ? { assigneeId: assignee.id } : {}) },
          });
          setReporting(false);
          setTitle("");
          setDetails("");
          setAssignee(null);
          setRef(Crypto.randomUUID());
          Alert.alert("Saved on this phone", "No signal right now. The issue will be sent automatically when you have signal.");
        } catch (err) {
          Alert.alert("Issue not saved", err instanceof Error ? err.message : "Please try again.");
        }
        return;
      }
      Alert.alert("Issue not saved", `${problem(e)} What you typed is still here.`);
    } finally {
      setBusy(false);
    }
  };

  const active = (items ?? []).filter((i) => i.status !== "resolved").length;
  if (!serverId) {
    return canReport ? <Text style={s.muted}>🔧 You can report an issue on this photo once it has uploaded.</Text> : null;
  }
  return (
    <View style={{ gap: 10 }}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <Text style={s.label}>To fix{active ? ` (${active})` : ""}</Text>
        {canReport && !reporting ? (
          <Pressable onPress={() => setReporting(true)} hitSlop={8} accessibilityRole="button">
            <Text style={{ color: C.link, fontWeight: "700" }}>🔧 Report issue{aboutMark ? ` about the ${aboutMark.name}` : ""}</Text>
          </Pressable>
        ) : null}
      </View>
      {offline ? <Text style={s.muted}>Offline: showing the issues saved on this phone.</Text> : null}
      {reporting ? (
        <View style={[s.card, { gap: 8 }]}>
          {aboutMark ? <Text style={{ color: C.text }}>📍 About the {aboutMark.name}</Text> : null}
          <TextInput style={s.input} maxLength={200} value={title} onChangeText={setTitle} placeholder="What needs fixing?" placeholderTextColor={C.muted} autoFocus />
          <TextInput style={[s.input, { minHeight: 60, textAlignVertical: "top" }]} multiline maxLength={2000} value={details} onChangeText={setDetails} placeholder="Details (optional)" placeholderTextColor={C.muted} />
          {canManage ? (
            <Pressable onPress={() => (people.length ? pickPerson(people, "Who should fix it?", (id) => setAssignee(people.find((p) => p.id === id) ?? null), true) : undefined)} hitSlop={6}>
              <Text style={{ color: C.link }}>Assign to: {assignee ? assignee.name : "nobody yet"} ▾</Text>
            </Pressable>
          ) : (
            <Text style={s.muted}>A manager will see this in the job's Issues list and assign it.</Text>
          )}
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Button title="Cancel" kind="secondary" style={{ flex: 1 }} onPress={() => setReporting(false)} />
            <Button title="Report issue" style={{ flex: 1 }} busy={busy} disabled={!title.trim()} onPress={() => void report()} />
          </View>
        </View>
      ) : null}
      {waitingReports.map((a) => <WaitingChange key={a.localId} a={a} what={a.label} />)}
      {items && !items.length && !reporting && !waitingReports.length ? <Text style={s.muted}>Nothing to fix on this photo.</Text> : null}
      {(items ?? []).map((i) => (
        <IssueCard key={i.id} issue={i} onChanged={() => void load()}
          markName={i.markupId ? marks.find((m) => m.id === i.markupId)?.name ?? null : undefined}
          onShowMark={i.markupId ? () => onShowMark?.(i.markupId!) : undefined} />
      ))}
    </View>
  );
}

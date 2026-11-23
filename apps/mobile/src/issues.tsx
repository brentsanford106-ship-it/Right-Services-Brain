import React, { useCallback, useEffect, useState } from "react";
import { Alert, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { router } from "expo-router";
import * as Crypto from "expo-crypto";
import { ApiError, ISSUE_EVENT_LABEL, ISSUE_STATUS_LABEL, NetworkError, issueStatusText, type IssueStatus } from "@rsb/photo-sync";
import { useApp } from "./state";
import { ServerImage, type ServerPhoto } from "./photos";
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

/** One issue and the buttons the viewer may use. Changing an issue needs a connection for now. */
export function IssueCard({ issue, onChanged, markName, onShowMark, showPhotoLink }: {
  issue: ServerIssue; onChanged: () => void; markName?: string | null; onShowMark?: () => void; showPhotoLink?: boolean;
}) {
  const app = useApp();
  const i = issue;
  const orgId = app.session?.orgId ?? "";
  const [mode, setMode] = useState<Mode>(null);
  const [note, setNote] = useState("");
  const [fixes, setFixes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<IssueEvent[] | null>(null);
  const [jobPhotos, setJobPhotos] = useState<ServerPhoto[]>([]);
  const people = useJobPeople(i.jobId, i.can.assign);

  const act = async (body: { action: string; note?: string | null; assigneeId?: string | null; fixPhotoIds?: string[] }) => {
    setBusy(true);
    try {
      await app.api.post(`/v1/orgs/${orgId}/photo-issues/${i.id}/actions`, { clientRef: Crypto.randomUUID(), expectedStatus: i.status, ...body });
      setMode(null);
      setNote("");
      setFixes([]);
      setHistory(null);
      onChanged();
    } catch (e) {
      Alert.alert("Not saved", problem(e));
      if (e instanceof ApiError && e.status === 409) onChanged();
    } finally {
      setBusy(false);
    }
  };
  const startSubmit = async () => {
    setMode("submit");
    const key = `photos-${i.jobId}`;
    try {
      const r = await app.api.get<{ items: ServerPhoto[] }>(`/v1/orgs/${orgId}/jobs/${i.jobId}/photos`);
      setJobPhotos(r.items);
      await app.cache.put(key, r.items);
    } catch {
      setJobPhotos((await app.cache.get<ServerPhoto[]>(key)) ?? []);
    }
  };
  const loadHistory = async () => {
    if (history) return setHistory(null);
    try {
      const r = await app.api.get<{ history: IssueEvent[] }>(`/v1/orgs/${orgId}/photo-issues/${i.id}`);
      setHistory(r.history);
    } catch (e) {
      Alert.alert("History not loaded", problem(e));
    }
  };
  const fixChoices = jobPhotos.filter((p) => p.id !== i.photoId && p.uploadStatus === "stored").sort((a, b) => b.capturedAt.localeCompare(a.capturedAt)).slice(0, 40);

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
      {i.fixPhotoIds.length ? (
        <View style={{ flexDirection: "row", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <Text style={s.muted}>Fix photo{i.fixPhotoIds.length > 1 ? "s" : ""}:</Text>
          {i.fixPhotoIds.map((id, n) => (
            <Pressable key={id} onPress={() => void openIssuePhoto(app, i.jobId, id)} hitSlop={6}><Text style={{ color: C.link, fontWeight: "600" }}>#{n + 1}</Text></Pressable>
          ))}
        </View>
      ) : null}

      {mode === null ? (
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
              <Text style={s.label}>Fix photos (optional)</Text>
              {fixChoices.length ? (
                <ScrollView horizontal contentContainerStyle={{ gap: 6 }}>
                  {fixChoices.map((p) => {
                    const on = fixes.includes(p.id);
                    return (
                      <Pressable key={p.id} accessibilityRole="button" accessibilityState={{ selected: on }} accessibilityLabel={`${p.stage} photo from ${new Date(p.capturedAt).toLocaleString()}`}
                        onPress={() => setFixes(on ? fixes.filter((x) => x !== p.id) : [...fixes, p.id].slice(0, 20))}
                        style={{ borderWidth: 3, borderColor: on ? C.brand : "transparent", borderRadius: 8 }}>
                        <ServerImage photoId={p.id} style={{ width: 72, height: 72, borderRadius: 6 }} thumb />
                        <Text style={{ position: "absolute", bottom: 2, left: 4, color: "#fff", fontSize: 11, fontWeight: "700", textShadowColor: "#000", textShadowRadius: 3 }}>{p.stage}{on ? " ✓" : ""}</Text>
                      </Pressable>
                    );
                  })}
                </ScrollView>
              ) : null}
              <Text style={s.muted}>Take an “After” photo of the fix first. Photos still uploading show up here once they're uploaded.</Text>
            </>
          ) : null}
          <TextInput style={[s.input, { minHeight: 60, textAlignVertical: "top" }]} multiline maxLength={2000} value={note} onChangeText={setNote} placeholderTextColor={C.muted}
            placeholder={mode === "send_back" ? "What still needs fixing? (needed)" : mode === "submit" ? "What did you do? (optional)" : "Note (optional)"} />
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Button title="Cancel" kind="secondary" style={{ flex: 1 }} onPress={() => setMode(null)} />
            <Button
              style={{ flex: 1 }}
              busy={busy}
              disabled={mode === "send_back" && !note.trim()}
              title={mode === "submit" ? "Send for review" : mode === "approve" ? "Approve fix" : mode === "send_back" ? "Send back" : "Reopen"}
              onPress={() => void act({ action: mode, note: note.trim() || null, ...(mode === "submit" ? { fixPhotoIds: fixes } : {}) })}
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
  const orgId = app.session?.orgId ?? "";
  const canReport = app.can("photo_issues.create");
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
      {items && !items.length && !reporting ? <Text style={s.muted}>Nothing to fix on this photo.</Text> : null}
      {(items ?? []).map((i) => (
        <IssueCard key={i.id} issue={i} onChanged={() => void load()}
          markName={i.markupId ? marks.find((m) => m.id === i.markupId)?.name ?? null : undefined}
          onShowMark={i.markupId ? () => onShowMark?.(i.markupId!) : undefined} />
      ))}
    </View>
  );
}

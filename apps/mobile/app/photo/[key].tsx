import React, { useCallback, useEffect, useRef, useState } from "react";
import { Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, TextInput, View, useWindowDimensions } from "react-native";
import { Stack, router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { hitTest } from "@rsb/photo-sync";
import { MarksLayer, fitRect, markNames, useMarks } from "../../src/markup";
import { NOTE_MAX, type Stage } from "@rsb/photo-sync";
import { useApp, useQueueVersion, useSyncStatus } from "../../src/state";
import { LocalImage, PersonBadge, ServerImage, mergeGallery, type ServerPhoto } from "../../src/photos";
import { canDeleteItem, confirmDelete, sharePhotos } from "../../src/photoActions";
import { PhotoComments } from "../../src/comments";
import { PhotoIssues } from "../../src/issues";
import { Button, C, Chip, DevBanner, SyncPill, STAGES, s } from "../../src/ui";

/**
 * Review one photo: full screen view, flag/unflag, note, Before/During/After.
 * Every change is saved on the phone first and uploaded by the sync queue, so it works offline.
 */
export default function Review() {
  const app = useApp();
  useQueueVersion();
  const sync = useSyncStatus();
  const { key, jobId } = useLocalSearchParams<{ key: string; jobId: string }>();
  const { width, height } = useWindowDimensions();
  const [server, setServer] = useState<ServerPhoto[]>([]);
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [showMarks, setShowMarks] = useState(true);
  const [picked, setPicked] = useState<string | null>(null); // a mark chosen to comment on

  useEffect(() => {
    void app.cache.get<ServerPhoto[]>(`photos-${jobId}`).then((v) => setServer(v ?? []));
  }, [app.cache, jobId]);

  const item = mergeGallery(app.queue, jobId, server, sync.uploadingId, { name: app.session?.displayName ?? "", membershipId: app.session?.membershipId ?? null, avatarAt: app.session?.avatarAt ?? null }).find(
    (i) => i.key === key || (key.startsWith("l:") && i.local?.localId === key.slice(2)) || (key.startsWith("s:") && i.server?.id === key.slice(2)),
  );

  useEffect(() => {
    if (item && draft === null) setDraft(item.note ?? "");
  }, [item, draft]);

  const serverId = item?.server?.id ?? item?.local?.serverId ?? null;
  const { marks, reload: reloadMarks } = useMarks(serverId);
  // Back from the drawing screen: show what was saved.
  useFocusEffect(useCallback(() => { void reloadMarks(); }, [reloadMarks]));

  // A typed note must never be lost just because someone left the screen without tapping "Save note".
  const pendingNote = useRef<(() => void) | null>(null);
  useEffect(() => () => pendingNote.current?.(), []);

  if (!item) {
    return (
      <View style={[s.screen, { padding: 24 }]}>
        <Text>This photo is no longer on this phone.</Text>
        <Button title="Back" kind="secondary" style={{ marginTop: 16 }} onPress={() => router.back()} />
      </View>
    );
  }

  const change = async (c: { flagged?: boolean; note?: string | null; stage?: Stage }) => {
    setSaving(true);
    try {
      if (item.local) await app.queue.edit(item.local.localId, c);
      else if (item.server)
        await app.queue.editRemote(
          {
            serverId: item.server.id,
            orgId: app.session!.orgId,
            jobId,
            jobNumber: item.server.jobNumber,
            stage: (["before", "during", "after"].includes(item.server.stage) ? item.server.stage : "during") as Stage,
            note: item.server.note,
            flagged: item.server.flagged,
            capturedAt: item.server.capturedAt,
          },
          c,
        );
      app.syncNow();
    } catch (e) {
      Alert.alert("Not saved", e instanceof Error ? e.message : "Please try again.");
    } finally {
      setSaving(false);
    }
  };

  const noteChanged = (draft ?? "") !== (item.note ?? "");
  const saveNote = () => change({ note: (draft ?? "").trim() || null });
  const imgH = Math.min(height * 0.55, width * 1.33);
  // Drawings are measured against the display copy on the server. Photos still only on this phone can't have any yet.
  const pw = item.server?.widthPx ?? 0;
  const ph = item.server?.heightPx ?? 0;
  const fit = fitRect(width - (item.flagged ? 8 : 0), imgH, pw, ph);
  const canDraw = app.can("photo_markups.create") && !!serverId && !!item.server?.hasPreview && pw > 0 && ph > 0;
  const names = markNames(marks);
  const markList = marks.map((m, i) => ({ id: m.id, name: names[i]! }));
  const own = !item.server || (item.server.uploadedByMe ?? item.server.uploadedBy === app.session?.displayName);
  const canEdit = own ? app.can("photos.upload") : app.can("photo_flags.manage");
  pendingNote.current = noteChanged && canEdit ? () => void saveNote() : null;

  return (
    <KeyboardAvoidingView style={s.screen} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <Stack.Screen options={{ title: new Date(item.capturedAt).toLocaleString() }} />
      <DevBanner />
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 40 }}>
        <View style={{ backgroundColor: "#000", borderWidth: item.flagged ? 4 : 0, borderColor: C.flag }}>
          {item.local && !item.local.remoteOnly ? (
            <LocalImage localId={item.local.localId} which="original" style={{ width: "100%", height: imgH }} />
          ) : item.server ? (
            <ServerImage photoId={item.server.id} style={{ width: "100%", height: imgH }} contain />
          ) : null}
          {showMarks && marks.length > 0 && pw && ph ? (
            <Pressable
              style={{ position: "absolute", left: fit.x, top: fit.y, width: fit.w, height: fit.h }}
              accessibilityLabel={`${marks.length} drawing${marks.length === 1 ? "" : "s"} on this photo. Tap one to comment on it.`}
              onPress={(e) => {
                const i = hitTest(marks, e.nativeEvent.locationX, e.nativeEvent.locationY, fit.w, fit.h, 24);
                setPicked(i >= 0 ? marks[i]!.id : null);
              }}
            >
              <MarksLayer marks={marks} w={pw} h={ph} width={fit.w} height={fit.h} highlight={marks.findIndex((m) => m.id === picked)} />
            </Pressable>
          ) : null}
        </View>
        {marks.length > 0 || canDraw ? (
          <View style={{ flexDirection: "row", gap: 10, paddingHorizontal: 16, paddingTop: 12 }}>
            {marks.length > 0 ? (
              <Button title={showMarks ? `Hide drawings (${marks.length})` : `Show drawings (${marks.length})`} kind="secondary" style={{ flex: 1 }} onPress={() => setShowMarks((v) => !v)} />
            ) : null}
            {canDraw ? (
              <Button title="✎ Draw" style={{ flex: 1 }} onPress={() => router.push({ pathname: "/photo/draw", params: { photoId: serverId!, w: String(pw), h: String(ph) } })} />
            ) : null}
          </View>
        ) : null}

        <View style={{ padding: 16, gap: 16 }}>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
            <SyncPill state={item.state === "server_missing_file" ? "waiting" : item.state} />
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <PersonBadge personKey={item.personKey} name={item.personName} personId={item.personId} avatarAt={item.personAvatarAt} />
              <Text style={s.muted}>Taken by {item.personKey === "me" ? "you" : item.personName ?? "unknown"}</Text>
            </View>
          </View>
          {item.local?.lastError ? <Text style={s.error}>{item.local.lastError}</Text> : null}

          <Button
            title={item.flagged ? "⚑  Flagged — tap to unflag" : "⚑  Flag this photo"}
            kind={item.flagged ? "danger" : "secondary"}
            disabled={!canEdit || saving}
            onPress={() => void change({ flagged: !item.flagged })}
          />

          <View>
            <Text style={s.label}>Stage</Text>
            <View style={{ flexDirection: "row" }}>
              {STAGES.map((st) => (
                <Chip key={st.value} label={st.label} active={item.stage === st.value} onPress={() => canEdit && void change({ stage: st.value })} />
              ))}
            </View>
          </View>

          <View>
            <Text style={s.label}>Note</Text>
            <TextInput
              style={[s.input, { minHeight: 90, paddingTop: 12, textAlignVertical: "top" }]}
              multiline
              editable={canEdit}
              maxLength={NOTE_MAX}
              value={draft ?? ""}
              onChangeText={setDraft}
              onBlur={() => pendingNote.current?.()}
              placeholder="Add a note (optional)" placeholderTextColor={C.muted}
            />
            {noteChanged ? (
              <Button title="Save note" style={{ marginTop: 10 }} busy={saving} onPress={() => void saveNote()} />
            ) : null}
          </View>

          <PhotoIssues key={`i-${item.key}`} jobId={jobId} serverId={serverId} marks={markList}
            aboutMark={picked ? markList.find((m) => m.id === picked) ?? null : null}
            onShowMark={(id) => { setShowMarks(true); setPicked(id); }} />

          <PhotoComments key={item.key} jobId={jobId} serverId={serverId} localId={item.local && !item.local.remoteOnly ? item.local.localId : null}
            marks={markList} aboutMark={picked ? markList.find((m) => m.id === picked) ?? null : null} onClearMark={() => setPicked(null)}
            onShowMark={(id) => { setShowMarks(true); setPicked(id); }} />

          <View style={[s.card, { gap: 4 }]}>
            <Text style={s.muted}>Job: {item.local?.jobNumber ?? item.server?.jobNumber}</Text>
            <Text style={s.muted}>
              Taken: {item.server?.capturedAtKnown === false || item.local?.capturedAtKnown === false ? `unknown (added ${new Date(item.capturedAt).toLocaleString()})` : new Date(item.capturedAt).toLocaleString()}
            </Text>
            {item.server && item.server.captureSource && item.server.captureSource !== "in_app_camera" ? (
              <Text style={s.muted}>Uploaded by: {item.server.uploadedByMe ? "you" : item.server.uploadedBy} ({item.server.captureSource === "imported" ? "imported from a photo library" : "uploaded on the website"})</Text>
            ) : !item.server && item.local?.captureSource === "imported" ? (
              <Text style={s.muted}>Imported from your photo library</Text>
            ) : null}
            {item.local?.location ? (
              <Text style={s.muted}>
                Location: {item.local.location.latitude.toFixed(5)}, {item.local.location.longitude.toFixed(5)}
              </Text>
            ) : item.server?.latitude != null ? (
              <Text style={s.muted}>
                Location: {item.server.latitude.toFixed(5)}, {item.server.longitude?.toFixed(5)}
              </Text>
            ) : (
              <Text style={s.muted}>Location: not recorded</Text>
            )}
          </View>

          <View style={{ flexDirection: "row", gap: 12 }}>
            <Button
              title={sharing ? "Preparing…" : "Share"}
              kind="secondary"
              style={{ flex: 1 }}
              onPress={() => {
                setSharing(true);
                void sharePhotos(app, [item], item.local?.jobNumber ?? item.server?.jobNumber ?? "job").finally(() => setSharing(false));
              }}
            />
            {canDeleteItem(item) ? (
              <Button
                title="Delete"
                kind="secondary"
                style={{ flex: 1, borderColor: C.flag }}
                onPress={() =>
                  confirmDelete(app, [item], (n) => {
                    if (n) {
                      pendingNote.current = null; // nothing to save on a deleted photo
                      router.back();
                    }
                  })
                }
              />
            ) : null}
          </View>

          <Button title="Back to camera / gallery" kind="secondary" onPress={() => router.back()} />
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

import React from "react";
import { Alert, FlatList, Pressable, Text, View } from "react-native";
import { router } from "expo-router";
import { syncStateOf } from "@rsb/photo-sync";
import { useActionsVersion, useApp, useCommentsVersion, useQueueVersion, useSyncStatus } from "../src/state";
import { LocalImage } from "../src/photos";
import { Button, C, DevBanner, Empty, SyncPill, s } from "../src/ui";

/** Upload status and recovery for photos that could not be sent. Nothing here is ever deleted without asking. */
export default function Sync() {
  const app = useApp();
  useQueueVersion();
  useCommentsVersion();
  useActionsVersion();
  const st = useSyncStatus();
  const others = { comments: app.comments.counts(), changes: app.actions.counts() };
  const pending = app.queue.pending();
  const counts = app.queue.counts();

  const discard = (localId: string) =>
    Alert.alert("Delete this photo?", "It has NOT been uploaded. Deleting removes it from this phone for good.", [
      { text: "Keep", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: () => void app.queue.discard(localId) },
    ]);

  return (
    <View style={s.screen}>
      <DevBanner />
      <FlatList
        data={pending}
        keyExtractor={(p) => p.localId}
        contentContainerStyle={{ padding: 16, gap: 10, paddingBottom: 40 }}
        ListHeaderComponent={
          <View style={{ gap: 12, marginBottom: 6 }}>
            <View style={s.card}>
              <Text style={{ fontSize: 17, fontWeight: "700", color: C.text }}>
                {counts.waiting === 0 && counts.needsAttention === 0 ? "Everything is uploaded" : `${counts.waiting} waiting · ${counts.needsAttention} need attention`}
              </Text>
              <Text style={[s.muted, { marginTop: 4 }]}>
                {app.online ? "Connected." : "No connection right now. Photos are safe on this phone and will upload when you're back online."}
                {st.lastRunAt ? ` Last check ${new Date(st.lastRunAt).toLocaleTimeString()}.` : ""}
                {st.lastStop === "sign_in_required" ? " Sign-in expired: open Settings and sign in again." : ""}
              </Text>
              {others.comments.waiting + others.comments.needsAttention + others.changes.waiting + others.changes.needsAttention > 0 ? (
                <Text style={[s.muted, { marginTop: 6 }]}>
                  Also waiting: {[
                    others.comments.waiting + others.comments.needsAttention ? `${others.comments.waiting + others.comments.needsAttention} comment${others.comments.waiting + others.comments.needsAttention === 1 ? "" : "s"}` : "",
                    others.changes.waiting + others.changes.needsAttention ? `${others.changes.waiting + others.changes.needsAttention} drawing or issue change${others.changes.waiting + others.changes.needsAttention === 1 ? "" : "s"}` : "",
                  ].filter(Boolean).join(", ")}.
                  {others.comments.needsAttention + others.changes.needsAttention ? " Some need you to look at them on their photo." : ""}
                </Text>
              ) : null}
              <Button title={st.running ? "Uploading…" : "Upload now"} busy={st.running} style={{ marginTop: 12 }} onPress={app.syncNow} />
            </View>
            <View style={[s.card, { backgroundColor: C.warnSoft, borderColor: C.warnSoft }]}>
              <Text style={{ color: C.warn, fontWeight: "700" }}>How uploading works on iPhone</Text>
              <Text style={{ color: C.text, marginTop: 4 }}>
                Photos upload while this app is open. If you switch to another app, an upload that already started can usually finish, but
                new uploads wait until you open the app again. If you swipe the app away, uploads stop until you reopen it. Nothing is lost
                either way. Open the app with a connection to finish.
              </Text>
            </View>
          </View>
        }
        ListEmptyComponent={<Empty title="No photos waiting" />}
        renderItem={({ item }) => {
          const state = syncStateOf(item, st.uploadingId);
          return (
            <View style={[s.card, { flexDirection: "row", gap: 12 }]}>
              {item.remoteOnly ? (
                <View style={{ width: 64, height: 64, borderRadius: 8, backgroundColor: C.line, alignItems: "center", justifyContent: "center" }}>
                  <Text style={s.muted}>edit</Text>
                </View>
              ) : (
                <LocalImage localId={item.localId} which="thumbnail" style={{ width: 64, height: 64, borderRadius: 8 }} />
              )}
              <View style={{ flex: 1, gap: 4 }}>
                <Pressable onPress={() => router.push({ pathname: "/photo/[key]", params: { key: `l:${item.localId}`, jobId: item.jobId } })}>
                  <Text style={{ fontWeight: "700", color: C.text }}>
                    {item.jobNumber} · {new Date(item.capturedAt).toLocaleString()}
                  </Text>
                </Pressable>
                <SyncPill state={state} />
                {item.remoteOnly ? <Text style={s.muted}>Flag/note change to send</Text> : !item.stored ? <Text style={s.muted}>{(item.byteLength / 1e6).toFixed(1)} MB</Text> : <Text style={s.muted}>Flag/note change to send</Text>}
                {item.lastError ? <Text style={state === "needs_attention" ? s.error : s.muted}>{item.lastError}</Text> : null}
                {state === "needs_attention" ? (
                  <View style={{ flexDirection: "row", gap: 8, marginTop: 4 }}>
                    <Button title="Try again" onPress={() => void app.queue.retry(item.localId).then(app.syncNow)} style={{ flex: 1 }} />
                    <Button title="Delete" kind="secondary" onPress={() => discard(item.localId)} style={{ flex: 1 }} />
                  </View>
                ) : null}
              </View>
            </View>
          );
        }}
      />
    </View>
  );
}

import React, { useCallback, useState } from "react";
import { Alert, FlatList, Pressable, RefreshControl, Text, View, useWindowDimensions } from "react-native";
import { Stack, useFocusEffect, useLocalSearchParams } from "expo-router";
import { ApiError, NetworkError } from "@rsb/photo-sync";
import { useApp } from "../../../src/state";
import { ServerImage, type ServerPhoto } from "../../../src/photos";
import { C, DevBanner, Empty, s } from "../../../src/ui";

type DeletedPhoto = ServerPhoto & { deletedAt: string; deletedBy: string; purgeAfter: string };

const daysLeft = (iso: string) => Math.max(0, Math.ceil((Date.parse(iso) - Date.now()) / 86_400_000));

/**
 * Recently deleted photos for one job, like the iPhone Photos album. Only for people allowed to
 * restore photos (permission photos.delete_any: owners and managers by default). The server checks it.
 */
export default function RecentlyDeleted() {
  const app = useApp();
  const { jobId, jobNumber } = useLocalSearchParams<{ jobId: string; jobNumber?: string }>();
  const [items, setItems] = useState<DeletedPhoto[]>([]);
  const [loading, setLoading] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const { width } = useWindowDimensions();
  const cols = width >= 700 ? 5 : 3;
  const size = Math.floor((width - 4 * (cols + 1)) / cols);
  const base = `/v1/orgs/${app.session!.orgId}`;
  const canPurge = app.can("photos.purge");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await app.api.get<{ items: DeletedPhoto[] }>(`${base}/jobs/${jobId}/photos/deleted`);
      setItems(res.items);
      setNote(null);
    } catch (e) {
      setNote(
        e instanceof NetworkError
          ? "Recently deleted needs a connection."
          : e instanceof ApiError && e.status === 403
            ? "Only owners and managers can see deleted photos."
            : "Couldn't load deleted photos.",
      );
    } finally {
      setLoading(false);
    }
  }, [app.api, base, jobId]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const restore = async (ids: string[]) => {
    setBusy(true);
    let failed = 0;
    for (const id of ids) {
      try {
        await app.api.post(`${base}/photos/${id}/restore`, {});
      } catch {
        failed++;
      }
    }
    setBusy(false);
    setSelected(new Set());
    if (failed) Alert.alert("Some photos weren't restored", `${failed} couldn't be restored. Check the connection and try again.`);
    void load();
  };

  const purge = async (ids: string[]) => {
    setBusy(true);
    try {
      await app.api.post(`${base}/photos/purge`, { photoIds: ids });
    } catch (e) {
      Alert.alert(
        "Not deleted",
        e instanceof NetworkError
          ? "Deleting forever needs a connection. Nothing was deleted."
          : e instanceof ApiError && e.status === 403
            ? "Only owners can delete photos forever."
            : "Something went wrong. Nothing was deleted.",
      );
    }
    setBusy(false);
    setSelected(new Set());
    void load();
  };

  /** Two steps on purpose: this can't be undone by anyone. */
  const confirmPurge = (ids: string[]) => {
    const what = ids.length === 1 ? "This photo" : `These ${ids.length} photos`;
    Alert.alert(`Delete ${ids.length === 1 ? "photo" : `${ids.length} photos`} forever?`, `${what} will be erased and can't be restored by anyone.`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Continue",
        style: "destructive",
        onPress: () =>
          Alert.alert("Are you sure?", "This can't be undone. The activity log will keep a note that the photo existed.", [
            { text: "Cancel", style: "cancel" },
            { text: "Delete Forever", style: "destructive", onPress: () => void purge(ids) },
          ]),
      },
    ]);
  };

  const chosen = [...selected];
  return (
    <View style={s.screen}>
      <Stack.Screen
        options={{
          title: "Recently Deleted",
          headerRight: items.length
            ? () => (
                <Pressable hitSlop={12} onPress={() => setSelected(selected.size === items.length ? new Set() : new Set(items.map((i) => i.id)))}>
                  <Text style={{ color: C.link, fontSize: 16 }}>{selected.size === items.length ? "Deselect All" : "Select All"}</Text>
                </Pressable>
              )
            : undefined,
        }}
      />
      <DevBanner />
      <Text style={[s.muted, { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8 }]}>
        {jobNumber ? `${jobNumber}: ` : ""}tap photos to choose them, then tap Restore. Restored photos go back into the job for everyone.
        {items[0] ? ` Photos are removed for good automatically after the company's keep time (see Settings).` : ""}
      </Text>
      {note ? <Text style={[s.error, { paddingHorizontal: 16 }]}>{note}</Text> : null}
      <FlatList
        style={{ flex: 1 }}
        key={cols}
        data={items}
        numColumns={cols}
        keyExtractor={(i) => i.id}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void load()} />}
        contentContainerStyle={{ padding: 4, paddingBottom: 120 }}
        ListEmptyComponent={loading || note ? undefined : <Empty title="No deleted photos" body="Photos deleted from this job show up here." />}
        renderItem={({ item }) => {
          const on = selected.has(item.id);
          return (
            <Pressable
              onPress={() => toggle(item.id)}
              style={{ margin: 2, width: size }}
              accessibilityLabel={`Deleted photo from ${new Date(item.capturedAt).toLocaleString()}${on ? ", selected" : ""}`}
            >
              {item.hasPreview ? (
                <ServerImage photoId={item.id} style={{ width: size, height: size, borderRadius: 6, opacity: on ? 0.75 : 1 }} />
              ) : (
                <View style={{ width: size, height: size, borderRadius: 6, backgroundColor: C.line, alignItems: "center", justifyContent: "center" }}>
                  <Text style={s.muted}>No preview</Text>
                </View>
              )}
              <View
                pointerEvents="none"
                style={{
                  position: "absolute",
                  right: 6,
                  top: size - 30,
                  width: 24,
                  height: 24,
                  borderRadius: 12,
                  borderWidth: 2,
                  borderColor: "#fff",
                  backgroundColor: on ? "#0a84ff" : "rgba(0,0,0,0.25)",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                {on ? <Text style={{ color: "#fff", fontWeight: "800", fontSize: 13 }}>✓</Text> : null}
              </View>
              <Text style={[s.muted, { fontSize: 11, marginTop: 2 }]} numberOfLines={2}>
                Deleted by {item.deletedBy} · {new Date(item.deletedAt).toLocaleDateString()}
              </Text>
              <Text style={[s.muted, { fontSize: 11 }]}>{daysLeft(item.purgeAfter) === 0 ? "Removed today" : `${daysLeft(item.purgeAfter)} days left`}</Text>
            </Pressable>
          );
        }}
      />
      {items.length ? (
        <View
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 0,
            paddingTop: 12,
            paddingBottom: 34,
            paddingHorizontal: 20,
            backgroundColor: C.card,
            borderTopWidth: 1,
            borderTopColor: C.line,
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          {canPurge ? (
            <Pressable accessibilityRole="button" disabled={!chosen.length || busy} hitSlop={12} onPress={() => confirmPurge(chosen)}>
              <Text style={{ fontSize: 17, fontWeight: "600", color: chosen.length ? C.flag : C.muted }}>Delete</Text>
            </Pressable>
          ) : null}
          <Text style={{ fontSize: 15, fontWeight: "600", color: C.text }}>
            {chosen.length ? `${chosen.length} Selected` : "Select photos"}
          </Text>
          <Pressable accessibilityRole="button" disabled={!chosen.length || busy} hitSlop={12} onPress={() => void restore(chosen)}>
            <Text style={{ fontSize: 17, fontWeight: "600", color: chosen.length ? C.link : C.muted }}>{busy ? "Working…" : "Restore"}</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

import React, { useCallback, useMemo, useState } from "react";
import { FlatList, Pressable, RefreshControl, ScrollView, Text, View, useWindowDimensions } from "react-native";
import { Stack, router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { NetworkError } from "@rsb/photo-sync";
import { useApp, useQueueVersion, useSyncStatus } from "../../../src/state";
import { applyFilter, mergeGallery, LocalImage, ServerImage, type Filter, type GalleryItem, type ServerPhoto } from "../../../src/photos";
import { C, Chip, DevBanner, Empty, FlagBadge, SyncPill, s } from "../../../src/ui";

const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "before", label: "Before" },
  { value: "during", label: "During" },
  { value: "after", label: "After" },
  { value: "flagged", label: "⚑ Flagged" },
];

export default function JobGallery() {
  const app = useApp();
  useQueueVersion();
  const sync = useSyncStatus();
  const { jobId, jobNumber, title } = useLocalSearchParams<{ jobId: string; jobNumber?: string; title?: string }>();
  const [server, setServer] = useState<ServerPhoto[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [loading, setLoading] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const { width } = useWindowDimensions();
  const cols = width >= 700 ? 5 : 3; // iPad shows more per row
  const size = Math.floor((width - 4 * (cols + 1)) / cols);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await app.api.get<{ items: ServerPhoto[] }>(`/v1/orgs/${app.session!.orgId}/jobs/${jobId}/photos`);
      setServer(res.items);
      setNote(null);
      for (const p of res.items) await app.queue.absorbServer(p);
      await app.cache.put(`photos-${jobId}`, res.items);
    } catch (e) {
      setServer((await app.cache.get<ServerPhoto[]>(`photos-${jobId}`)) ?? []);
      setNote(e instanceof NetworkError ? "Offline: showing what's saved on this phone. Older photos need a connection to view." : "Couldn't refresh from the server.");
    } finally {
      setLoading(false);
    }
  }, [app.api, app.cache, app.queue, app.session, jobId]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const all = mergeGallery(app.queue, jobId, server, sync.uploadingId);
  const items = useMemo(() => applyFilter(all, filter), [all, filter]);
  const waiting = all.filter((i) => i.state === "waiting" || i.state === "uploading").length;
  const attention = all.filter((i) => i.state === "needs_attention").length;

  const open = (i: GalleryItem) =>
    router.push({ pathname: "/photo/[key]", params: { key: i.key, jobId, ids: items.map((x) => x.key).join(",") } });

  return (
    <View style={s.screen}>
      <Stack.Screen
        options={{
          title: jobNumber ?? "Photos",
          headerRight: app.can("jobs.manage")
            ? () => (
                <Pressable hitSlop={12} onPress={() => router.push({ pathname: "/jobs/edit", params: { jobId } })}>
                  <Text style={{ color: C.brand, fontSize: 16 }}>Edit job</Text>
                </Pressable>
              )
            : undefined,
        }}
      />
      <DevBanner />
      <View style={{ paddingHorizontal: 16, paddingTop: 12 }}>
        {title ? <Text style={{ fontSize: 16, color: C.text, fontWeight: "600" }}>{title}</Text> : null}
        <Text style={[s.muted, { marginTop: 2 }]}>
          {all.length} photo{all.length === 1 ? "" : "s"}
          {waiting ? ` · ${waiting} waiting to upload` : ""}
          {attention ? ` · ${attention} need attention` : ""}
        </Text>
        {note ? <Text style={[s.muted, { marginTop: 6 }]}>{note}</Text> : null}
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerStyle={{ padding: 12, paddingHorizontal: 16 }}>
        {FILTERS.map((f) => (
          <Chip key={f.value} label={f.label} active={filter === f.value} tone={f.value === "flagged" ? "flag" : undefined} onPress={() => setFilter(f.value)} />
        ))}
      </ScrollView>
      <FlatList
        key={cols}
        data={items}
        numColumns={cols}
        keyExtractor={(i) => i.key}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void load()} />}
        contentContainerStyle={{ padding: 4, paddingBottom: 120 }}
        ListEmptyComponent={loading ? undefined : <Empty title={filter === "all" ? "No photos yet" : "No photos match this filter"} body={filter === "all" ? "Tap “Take Photos” to start." : undefined} />}
        renderItem={({ item }) => (
          <Pressable onPress={() => open(item)} style={{ margin: 2, width: size, height: size }} accessibilityLabel={`${item.stage} photo${item.flagged ? ", flagged" : ""}`}>
            {item.local && !item.local.remoteOnly ? (
              <LocalImage localId={item.local.localId} which="thumbnail" style={{ width: size, height: size, borderRadius: 6 }} />
            ) : item.server?.hasPreview ? (
              <ServerImage photoId={item.server.id} style={{ width: size, height: size, borderRadius: 6 }} />
            ) : (
              <View style={{ width: size, height: size, borderRadius: 6, backgroundColor: C.line, alignItems: "center", justifyContent: "center" }}>
                <Text style={s.muted}>{item.state === "server_missing_file" ? "File not\nuploaded yet" : "No preview"}</Text>
              </View>
            )}
            {item.flagged ? (
              <View style={{ position: "absolute", top: 4, right: 4 }}>
                <FlagBadge />
              </View>
            ) : null}
            <View style={{ position: "absolute", bottom: 4, left: 4 }}>
              {item.state !== "server" && item.state !== "server_missing_file" ? <SyncPill state={item.state} compact /> : null}
            </View>
            {item.flagged ? <View pointerEvents="none" style={{ position: "absolute", inset: 0, borderWidth: 3, borderColor: C.flag, borderRadius: 6 }} /> : null}
          </Pressable>
        )}
      />
      <Pressable
        accessibilityRole="button"
        onPress={() => router.push({ pathname: "/jobs/[jobId]/camera", params: { jobId, jobNumber: jobNumber ?? "" } })}
        style={({ pressed }) => ({ position: "absolute", left: 16, right: 16, bottom: 32, backgroundColor: C.brand, borderRadius: 14, paddingVertical: 18, alignItems: "center", opacity: pressed ? 0.8 : 1 })}
      >
        <Text style={{ color: "#fff", fontWeight: "800", fontSize: 18 }}>📷  Take Photos</Text>
      </Pressable>
    </View>
  );
}

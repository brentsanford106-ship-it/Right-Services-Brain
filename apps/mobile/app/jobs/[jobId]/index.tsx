import React, { useCallback, useMemo, useState } from "react";
import { Alert, FlatList, Pressable, RefreshControl, ScrollView, Text, View, useWindowDimensions } from "react-native";
import { Stack, router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { ApiError, NetworkError } from "@rsb/photo-sync";
import { useApp, useQueueVersion, useSyncStatus, type Job } from "../../../src/state";
import { applyFilter, mergeGallery, LocalImage, ServerImage, type Filter, type GalleryItem, type ServerPhoto } from "../../../src/photos";
import { confirmDelete, sharePhotos } from "../../../src/photoActions";
import { C, Chip, DevBanner, Empty, FlagBadge, JOB_STATUSES, StatusPill, SyncPill, s } from "../../../src/ui";

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
  const [job, setJob] = useState<Job | null>(null);
  // Select mode, like the iPhone Photos app: tap Select, tap photos, then Share or Delete.
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busyAction, setBusyAction] = useState(false);
  // How many photos are in Recently deleted; null when this person can't restore (or we're offline).
  const [deletedCount, setDeletedCount] = useState<number | null>(null);
  const { width } = useWindowDimensions();
  const cols = width >= 700 ? 5 : 3; // iPad shows more per row
  const size = Math.floor((width - 4 * (cols + 1)) / cols);

  const load = useCallback(async () => {
    setLoading(true);
    // Recently deleted: the server only answers for people allowed to restore photos.
    app.api
      .get<{ items: unknown[] }>(`/v1/orgs/${app.session!.orgId}/jobs/${jobId}/photos/deleted`)
      .then((r) => setDeletedCount(r.items.length))
      .catch(() => setDeletedCount(null));
    // Job details (status etc.): from the server when online, otherwise the copy saved on this phone.
    app.api
      .get<Job>(`/v1/orgs/${app.session!.orgId}/jobs/${jobId}`)
      .then(async (j) => {
        setJob(j);
        await app.cache.put(`job-${jobId}`, j);
      })
      .catch(async () => setJob((await app.cache.get<Job>(`job-${jobId}`)) ?? null));
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

  const changeStatus = () => {
    if (!job) return;
    Alert.alert("Job status", `${job.jobNumber}: choose a new status. This needs a connection.`, [
      ...JOB_STATUSES.filter((x) => x.value !== job.status).map((x) => ({
        text: x.label,
        onPress: () => {
          app.api
            .patch<Job>(`/v1/orgs/${app.session!.orgId}/jobs/${jobId}`, { status: x.value })
            .then(async () => {
              const next = { ...job, status: x.value };
              setJob(next);
              await app.cache.put(`job-${jobId}`, next);
            })
            .catch((e) =>
              Alert.alert(
                "Status not changed",
                e instanceof NetworkError ? "No connection. Try again when you have signal." : e instanceof ApiError ? e.message : "Please try again.",
              ),
            );
        },
      })),
      { text: "Cancel", style: "cancel" },
    ]);
  };

  const toggle = (key: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const startSelecting = (first?: GalleryItem) => {
    setSelecting(true);
    setSelected(new Set(first ? [first.key] : []));
  };
  const stopSelecting = () => {
    setSelecting(false);
    setSelected(new Set());
  };
  const chosen = all.filter((i) => selected.has(i.key));
  const allShownSelected = items.length > 0 && items.every((i) => selected.has(i.key));
  const onDelete = () =>
    confirmDelete(app, chosen, () => {
      stopSelecting();
      void load();
    });
  const onShare = async () => {
    setBusyAction(true);
    try {
      await sharePhotos(app, chosen, job?.jobNumber ?? jobNumber ?? "job");
    } finally {
      setBusyAction(false);
    }
  };

  const open = (i: GalleryItem) =>
    router.push({ pathname: "/photo/[key]", params: { key: i.key, jobId, ids: items.map((x) => x.key).join(",") } });

  return (
    <View style={s.screen}>
      <Stack.Screen
        options={{
          title: jobNumber ?? "Photos",
          headerRight: () => (
            <View style={{ flexDirection: "row", gap: 18, alignItems: "center" }}>
              {selecting ? (
                <Pressable hitSlop={12} onPress={() => setSelected(allShownSelected ? new Set() : new Set(items.map((i) => i.key)))}>
                  <Text style={{ color: C.link, fontSize: 16 }}>{allShownSelected ? "Deselect All" : "Select All"}</Text>
                </Pressable>
              ) : app.can("jobs.manage") ? (
                <Pressable hitSlop={12} onPress={() => router.push({ pathname: "/jobs/edit", params: { jobId } })}>
                  <Text style={{ color: C.link, fontSize: 16 }}>Edit job</Text>
                </Pressable>
              ) : null}
              {all.length ? (
                <Pressable hitSlop={12} onPress={() => (selecting ? stopSelecting() : startSelecting())}>
                  <Text style={{ color: C.link, fontSize: 16, fontWeight: selecting ? "700" : "400" }}>{selecting ? "Cancel" : "Select"}</Text>
                </Pressable>
              ) : null}
            </View>
          ),
        }}
      />
      <DevBanner />
      <View style={{ paddingHorizontal: 16, paddingTop: 12 }}>
        {title || job ? <Text style={{ fontSize: 16, color: C.text, fontWeight: "600" }}>{job?.title ?? title}</Text> : null}
        {job ? (
          <View style={{ marginTop: 6 }}>
            <StatusPill status={job.status} onPress={app.can("jobs.manage") ? changeStatus : undefined} />
          </View>
        ) : null}
        <Text style={[s.muted, { marginTop: 2 }]}>
          {all.length} photo{all.length === 1 ? "" : "s"}
          {waiting ? ` · ${waiting} waiting to upload` : ""}
          {attention ? ` · ${attention} need attention` : ""}
        </Text>
        {note ? <Text style={[s.muted, { marginTop: 6 }]}>{note}</Text> : null}
        {deletedCount ? (
          <Pressable
            accessibilityRole="button"
            hitSlop={8}
            style={{ marginTop: 6, alignSelf: "flex-start" }}
            onPress={() => router.push({ pathname: "/jobs/[jobId]/deleted", params: { jobId, jobNumber: job?.jobNumber ?? jobNumber ?? "" } })}
          >
            <Text style={{ color: C.link, fontWeight: "600" }}>🗑  Recently Deleted ({deletedCount}) ›</Text>
          </Pressable>
        ) : null}
      </View>
      {/* flexShrink 0: with many photos the list below used to squeeze this row and cut the labels off. */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0, flexShrink: 0 }} contentContainerStyle={{ padding: 12, paddingHorizontal: 16 }}>
        {FILTERS.map((f) => (
          <Chip key={f.value} label={f.label} active={filter === f.value} tone={f.value === "flagged" ? "flag" : undefined} onPress={() => setFilter(f.value)} />
        ))}
      </ScrollView>
      <FlatList
        style={{ flex: 1 }}
        key={cols}
        data={items}
        numColumns={cols}
        keyExtractor={(i) => i.key}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void load()} />}
        contentContainerStyle={{ padding: 4, paddingBottom: 120 }}
        ListEmptyComponent={loading ? undefined : <Empty title={filter === "all" ? "No photos yet" : "No photos match this filter"} body={filter === "all" ? "Tap “Take Photos” to start." : undefined} />}
        renderItem={({ item }) => (
          <Pressable
            onPress={() => (selecting ? toggle(item.key) : open(item))}
            onLongPress={() => (selecting ? toggle(item.key) : startSelecting(item))}
            style={{ margin: 2, width: size, height: size }}
            accessibilityLabel={`${item.stage} photo${item.flagged ? ", flagged" : ""}${selecting ? (selected.has(item.key) ? ", selected" : ", not selected") : ""}`}
          >
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
            {selecting ? (
              <View pointerEvents="none" style={{ position: "absolute", inset: 0, borderRadius: 6, backgroundColor: selected.has(item.key) ? "rgba(255,255,255,0.35)" : "transparent" }}>
                <View
                  style={{
                    position: "absolute",
                    right: 6,
                    bottom: 6,
                    width: 24,
                    height: 24,
                    borderRadius: 12,
                    borderWidth: 2,
                    borderColor: "#fff",
                    backgroundColor: selected.has(item.key) ? "#0a84ff" : "rgba(0,0,0,0.25)",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  {selected.has(item.key) ? <Text style={{ color: "#fff", fontWeight: "800", fontSize: 13 }}>✓</Text> : null}
                </View>
              </View>
            ) : null}
          </Pressable>
        )}
      />
      {selecting ? (
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
          <Pressable accessibilityRole="button" disabled={!chosen.length || busyAction} hitSlop={12} onPress={() => void onShare()}>
            <Text style={{ fontSize: 17, color: chosen.length ? "#0a84ff" : C.muted }}>{busyAction ? "Preparing…" : "Share"}</Text>
          </Pressable>
          <Text style={{ fontSize: 15, fontWeight: "600", color: C.text }}>
            {chosen.length ? `${chosen.length} Photo${chosen.length > 1 ? "s" : ""} Selected` : "Select Items"}
          </Text>
          <Pressable accessibilityRole="button" disabled={!chosen.length || busyAction} hitSlop={12} onPress={onDelete}>
            <Text style={{ fontSize: 17, color: chosen.length ? C.flag : C.muted }}>Delete</Text>
          </Pressable>
        </View>
      ) : (
        <Pressable
          accessibilityRole="button"
          onPress={() => router.push({ pathname: "/jobs/[jobId]/camera", params: { jobId, jobNumber: jobNumber ?? "" } })}
          style={({ pressed }) => ({ position: "absolute", left: 16, right: 16, bottom: 32, backgroundColor: C.brand, borderRadius: 14, paddingVertical: 18, alignItems: "center", opacity: pressed ? 0.8 : 1 })}
        >
          <Text style={{ color: "#fff", fontWeight: "800", fontSize: 18 }}>📷  Take Photos</Text>
        </Pressable>
      )}
    </View>
  );
}

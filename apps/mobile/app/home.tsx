import React, { useCallback, useEffect, useState } from "react";
import { Image, Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { Stack, router, useFocusEffect } from "expo-router";
import { useApp, useQueueVersion, useSyncStatus, type Job } from "../src/state";
import { C, DevBanner, Logo, StatusPill, s } from "../src/ui";

interface Dashboard {
  activeJobs: number;
  photosLast7Days: number;
  flaggedPhotos: number;
  photosAwaitingUpload: number;
}

/** Home screen after sign-in: welcome, upload status, quick actions, and a few active jobs. */
export default function Home() {
  const app = useApp();
  useQueueVersion();
  const sync = useSyncStatus();
  const [dash, setDash] = useState<Dashboard | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(false);
  const [offline, setOffline] = useState(false);

  const load = useCallback(async () => {
    if (!app.session) return;
    setLoading(true);
    const base = `/v1/orgs/${app.session.orgId}`;
    void app.refreshPermissions();
    try {
      const [d, j] = await Promise.all([
        app.api.get<Dashboard>(`${base}/dashboard`),
        app.api.get<{ items: Job[] }>(`${base}/jobs?limit=200`),
      ]);
      setDash(d);
      setJobs(j.items);
      setOffline(false);
      await app.cache.put("dashboard", d);
      await app.cache.put("jobs", j.items);
    } catch {
      // Offline or server unreachable: show what was saved on this phone last time.
      setDash(await app.cache.get<Dashboard>("dashboard"));
      setJobs((await app.cache.get<Job[]>("jobs")) ?? []);
      setOffline(true);
    } finally {
      setLoading(false);
    }
  }, [app.api, app.cache, app.session, app.refreshPermissions]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  useEffect(() => {
    if (!app.session) router.replace("/login");
  }, [app.session]);

  if (!app.session) return null;

  const counts = app.queue.counts();
  const firstName = app.session.displayName.split(" ")[0];
  const active = jobs.filter((j) => j.status === "active").slice(0, 3);
  const canManage = app.can("jobs.manage");

  const upload = counts.needsAttention
    ? { text: `${counts.needsAttention} photo${counts.needsAttention > 1 ? "s" : ""} need attention`, fg: C.flag, bg: C.flagSoft }
    : counts.waiting
      ? {
          text: sync.running ? `Uploading ${counts.waiting} photo${counts.waiting > 1 ? "s" : ""}…` : `${counts.waiting} photo${counts.waiting > 1 ? "s" : ""} waiting to upload${app.online ? "" : " (offline)"}`,
          fg: C.warn,
          bg: C.warnSoft,
        }
      : { text: "All photos uploaded", fg: C.ok, bg: C.okSoft };

  const openJob = (j: Job) => router.push({ pathname: "/jobs/[jobId]", params: { jobId: j.id, jobNumber: j.jobNumber, title: j.title } });

  return (
    <View style={s.screen}>
      <Stack.Screen
        options={{
          title: "Home",
          headerRight: () => (
            <Pressable onPress={() => router.push("/settings")} hitSlop={12}>
              <Text style={{ color: C.link, fontSize: 16 }}>Settings</Text>
            </Pressable>
          ),
        }}
      />
      <DevBanner />
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 48, gap: 14 }} refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void load()} />}>
        <View style={{ height: 190, borderRadius: 16, overflow: "hidden", justifyContent: "space-between" }}>
          <Image
            source={require("../assets/brand/hero.jpg")}
            resizeMode="cover"
            style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, width: "100%", height: "100%" }}
            accessibilityIgnoresInvertColors
          />
          <View style={{ alignSelf: "flex-end", backgroundColor: "#fff", borderRadius: 10, padding: 6, margin: 12 }}>
            <Logo height={34} />
          </View>
          <View style={{ backgroundColor: "rgba(20,20,24,0.62)", paddingHorizontal: 16, paddingVertical: 12, borderTopWidth: 3, borderTopColor: C.brand }}>
            <Text style={{ fontSize: 22, fontWeight: "700", color: "#fff" }}>Hi, {firstName}</Text>
            <Text style={{ color: "#e6e8eb", marginTop: 2 }}>{app.session.orgName}</Text>
          </View>
        </View>

        <Pressable onPress={() => router.push("/sync")} style={({ pressed }) => ({ backgroundColor: upload.bg, borderRadius: 12, padding: 14, opacity: pressed ? 0.7 : 1 })}>
          <Text style={{ color: upload.fg, fontWeight: "700", fontSize: 16 }}>{upload.text} ›</Text>
        </Pressable>

        <View style={{ flexDirection: "row", gap: 12 }}>
          <BigAction label="Jobs" sub="Find a job, take photos" onPress={() => router.push("/jobs")} primary />
          {canManage ? <BigAction label="+ New job" sub="Start a new job" onPress={() => router.push("/jobs/edit")} /> : null}
        </View>

        {dash ? (
          <View style={{ flexDirection: "row", gap: 12 }}>
            <Stat label="Active jobs" value={dash.activeJobs} />
            <Stat label="Photos this week" value={dash.photosLast7Days} />
            <Stat label="Flagged" value={dash.flaggedPhotos} tone={dash.flaggedPhotos ? C.flag : undefined} />
          </View>
        ) : null}
        {offline ? <Text style={s.muted}>Offline: showing what was saved on this phone.</Text> : null}

        {active.length ? (
          <View style={{ gap: 10 }}>
            <Text style={s.label}>Active jobs</Text>
            {active.map((j) => (
              <Pressable key={j.id} onPress={() => openJob(j)} style={({ pressed }) => [s.card, { opacity: pressed ? 0.7 : 1 }]}>
                <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                  <Text style={{ fontSize: 16, fontWeight: "700", color: C.text }}>{j.jobNumber}</Text>
                  <StatusPill status={j.status} />
                </View>
                <Text style={{ color: C.text, marginTop: 2 }}>{j.title}</Text>
                {j.siteName ? <Text style={[s.muted, { marginTop: 2 }]}>{j.siteName}</Text> : null}
              </Pressable>
            ))}
            <Pressable onPress={() => router.push("/jobs")} hitSlop={8}>
              <Text style={{ color: C.link, fontWeight: "600", fontSize: 16 }}>See all jobs ›</Text>
            </Pressable>
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

function BigAction(props: { label: string; sub: string; onPress: () => void; primary?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={props.onPress}
      style={({ pressed }) => ({
        flex: 1,
        minHeight: 96,
        borderRadius: 14,
        padding: 16,
        justifyContent: "center",
        backgroundColor: props.primary ? C.brand : C.card,
        borderWidth: props.primary ? 0 : 1,
        borderColor: C.line,
        opacity: pressed ? 0.8 : 1,
      })}
    >
      <Text style={{ fontSize: 20, fontWeight: "700", color: props.primary ? "#fff" : C.ink }}>{props.label}</Text>
      <Text style={{ marginTop: 4, color: props.primary ? "#ffe3ea" : C.muted }}>{props.sub}</Text>
    </Pressable>
  );
}

function Stat(props: { label: string; value: number; tone?: string }) {
  return (
    <View style={[s.card, { flex: 1, paddingVertical: 12 }]}>
      <Text style={{ fontSize: 24, fontWeight: "700", color: props.tone ?? C.ink }}>{props.value}</Text>
      <Text style={[s.muted, { marginTop: 2, fontSize: 13 }]}>{props.label}</Text>
    </View>
  );
}

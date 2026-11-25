import React, { useCallback, useEffect, useState } from "react";
import { Image, Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { Stack, router, useFocusEffect } from "expo-router";
import { useApp, useQueueVersion, useSyncStatus, type Job } from "../src/state";
import { BRAND, BrandGradient, C, DevBanner, HeaderIcon, IconBubble, ListGroup, ListRow, LogoPlate, PhotoShade, R, SectionHeader, s, type IconName } from "../src/ui";
import { JobCard } from "../src/JobCard";

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
  const [toFix, setToFix] = useState<{ mine: number; review: number } | null>(null);
  const [unread, setUnread] = useState(0);

  const load = useCallback(async () => {
    if (!app.session) return;
    setLoading(true);
    const base = `/v1/orgs/${app.session.orgId}`;
    void app.refreshPermissions();
    // New alerts (in-app; checked each time Home is shown).
    void app.api.get<{ unreadCount: number }>(`${base}/notifications/unread-count`).then((r) => setUnread(r.unreadCount)).catch(() => undefined);
    // "To fix": issues assigned to me, and (managers) fixes waiting for review. Quietly skipped when offline.
    void Promise.all([
      app.api.get<{ items: unknown[] }>(`${base}/photo-issues?assigned=me&status=active`),
      app.can("photo_issues.manage") ? app.api.get<{ items: { can: { approve: boolean } }[] }>(`${base}/photo-issues?status=awaiting_review`) : Promise.resolve({ items: [] }),
    ]).then(([m, r]) => setToFix({ mine: m.items.length, review: r.items.filter((i) => i.can.approve).length })).catch(() => undefined);
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

  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";

  return (
    <View style={s.screen}>
      <Stack.Screen
        options={{
          title: "Home",
          headerRight: () => <HeaderIcon name="settings" label="Settings" onPress={() => router.push("/settings")} />,
        }}
      />
      <DevBanner />
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 48, gap: 14 }} refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void load()} />}>
        {/* Banner: crew photo, logo, and a greeting on a dark fade. */}
        <View style={{ height: 212, borderRadius: R.xl, overflow: "hidden", backgroundColor: "#111" }}>
          <Image
            source={BRAND.hero}
            resizeMode="cover"
            style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, width: "100%", height: "100%" }}
            accessibilityIgnoresInvertColors
          />
          <PhotoShade />
          <LogoPlate height={26} style={{ position: "absolute", top: 14, left: 14 }} />
          <View style={{ position: "absolute", left: 18, right: 18, bottom: 18 }}>
            <Text style={{ fontSize: 27, fontWeight: "800", color: "#fff", letterSpacing: -0.5 }} numberOfLines={1} adjustsFontSizeToFit>
              {greeting}, {firstName}
            </Text>
            <Text style={{ color: "rgba(255,255,255,0.82)", marginTop: 2, fontSize: 14.5, fontWeight: "500" }}>{app.session.orgName}</Text>
          </View>
          <View style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 4, backgroundColor: C.brand }} />
        </View>

        {dash ? (
          <View style={{ flexDirection: "row", gap: 10 }}>
            <Stat label="Active jobs" value={dash.activeJobs} />
            <Stat label="Photos this week" value={dash.photosLast7Days} />
            <Stat label="Flagged" value={dash.flaggedPhotos} tone={dash.flaggedPhotos ? C.flag : undefined} />
          </View>
        ) : null}
        {offline ? <Text style={[s.muted, { marginHorizontal: 4 }]}>Offline: showing what was saved on this phone.</Text> : null}

        <View style={{ flexDirection: "row", gap: 10 }}>
          <BigAction icon="camera" label="Jobs & photos" sub="Find a job, take photos" onPress={() => router.push("/jobs")} primary />
          {canManage ? <BigAction icon="plus" label="New job" sub="Start a new job" onPress={() => router.push("/jobs/edit")} /> : null}
        </View>

        <ListGroup>
          <ListRow
            icon={counts.needsAttention ? "alert" : counts.waiting ? "cloudUp" : "cloudCheck"}
            iconColor={upload.fg}
            iconBg={upload.bg}
            title={upload.text}
            titleColor={counts.needsAttention ? C.flag : undefined}
            subtitle={counts.needsAttention || counts.waiting ? "Tap to see uploads" : undefined}
            onPress={() => router.push("/sync")}
          />
          <ListRow icon="bell" title="Alerts" badge={unread ? `${unread} new` : undefined} onPress={() => router.push("/alerts")} accessibilityLabel={unread ? `${unread} new alert${unread > 1 ? "s" : ""}` : "Alerts"} />
          {toFix && (toFix.mine || toFix.review) ? (
            <ListRow
              icon="wrench"
              iconColor={C.fix}
              iconBg={C.fixSoft}
              title="To fix"
              subtitle={[toFix.mine ? `${toFix.mine} to fix` : "", toFix.review ? `${toFix.review} waiting for your review` : ""].filter(Boolean).join(" · ")}
              onPress={() => router.push("/issues")}
            />
          ) : null}
        </ListGroup>

        {active.length ? (
          <View style={{ gap: 10, marginTop: 4 }}>
            <SectionHeader title="Active jobs" action="See all" onAction={() => router.push("/jobs")} />
            {active.map((j) => (
              <JobCard key={j.id} job={j} onPress={() => openJob(j)} />
            ))}
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

function BigAction(props: { icon: IconName; label: string; sub: string; onPress: () => void; primary?: boolean }) {
  const fg = props.primary ? "#fff" : C.text;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      onPress={props.onPress}
      style={({ pressed }) => [
        props.primary ? { backgroundColor: C.brand, boxShadow: "0 8px 20px rgba(212,14,59,0.32)" } : s.card,
        { flex: 1, minHeight: 118, borderRadius: R.lg + 2, padding: 16, justifyContent: "space-between", overflow: "hidden", transform: [{ scale: pressed ? 0.98 : 1 }] },
      ]}
    >
      {props.primary ? <BrandGradient /> : null}
      <IconBubble name={props.icon} color={props.primary ? "#fff" : C.brand} bg={props.primary ? "rgba(255,255,255,0.2)" : C.brandSoft} size={40} />
      <View style={{ marginTop: 12 }}>
        <Text style={{ fontSize: 17.5, fontWeight: "700", color: fg }}>{props.label}</Text>
        <Text style={{ marginTop: 2, fontSize: 13, color: props.primary ? "rgba(255,255,255,0.82)" : C.muted }}>{props.sub}</Text>
      </View>
    </Pressable>
  );
}

function Stat(props: { label: string; value: number; tone?: string }) {
  return (
    <View style={[s.card, { flex: 1, paddingVertical: 12, paddingHorizontal: 12 }]}>
      <Text style={{ fontSize: 26, fontWeight: "800", color: props.tone ?? C.text, letterSpacing: -0.5 }}>{props.value}</Text>
      <Text style={{ marginTop: 1, fontSize: 12, fontWeight: "600", color: C.muted }} numberOfLines={1} adjustsFontSizeToFit>
        {props.label}
      </Text>
    </View>
  );
}

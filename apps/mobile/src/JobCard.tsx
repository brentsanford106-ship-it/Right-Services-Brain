import React from "react";
import { Pressable, Text, View } from "react-native";
import type { Job } from "./state";
import { C, Icon, IconBubble, StatusPill, s } from "./ui";

/** One job in a list: number, name, site, status, and how many of its photos still need to upload. */
export function JobCard({ job, onPress, pending }: { job: Job; onPress: () => void; pending?: number }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${job.jobNumber}, ${job.title}`}
      onPress={onPress}
      style={({ pressed }) => [s.card, { flexDirection: "row", alignItems: "center", gap: 12, padding: 12, transform: [{ scale: pressed ? 0.985 : 1 }], opacity: pressed ? 0.9 : 1 }]}
    >
      <IconBubble name="briefcase" color={C.brand} bg={C.brandSoft} size={48} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={{ fontSize: 12, fontWeight: "800", color: C.link, letterSpacing: 0.6 }}>{job.jobNumber}</Text>
        <Text style={{ fontSize: 16, fontWeight: "700", color: C.text, marginTop: 1 }} numberOfLines={1}>
          {job.title}
        </Text>
        {job.siteName ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 4, marginTop: 2 }}>
            <Icon name="pin" size={13} color={C.muted} />
            <Text style={{ fontSize: 13, color: C.muted, flexShrink: 1 }} numberOfLines={1}>
              {job.siteName}
            </Text>
          </View>
        ) : null}
        {pending ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 4, marginTop: 4 }}>
            <Icon name="cloudUp" size={14} color={C.warn} />
            <Text style={{ color: C.warn, fontWeight: "700", fontSize: 13 }}>{pending} to upload</Text>
          </View>
        ) : null}
      </View>
      <StatusPill status={job.status} />
    </Pressable>
  );
}

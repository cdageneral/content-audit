"use client";

import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer, ReferenceLine,
} from "recharts";
import type { ScoreHistoryPoint, CompetitorConfig } from "@/lib/db/projects";

interface Props {
  history: ScoreHistoryPoint[];
  competitors: CompetitorConfig[];
  competitorColors: string[];
}

const CLIENT_COLOR = "#6366f1";

export default function TrendChart({ history, competitors, competitorColors }: Props) {
  // Pivot history into chart data points keyed by date
  const dateMap = new Map<string, Record<string, number>>();

  for (const point of history) {
    const dateKey = formatDate(point.runAt);
    if (!dateMap.has(dateKey)) dateMap.set(dateKey, { date: dateKey as unknown as number });
    const entry = dateMap.get(dateKey)!;
    if (!point.competitorId) {
      entry["client"] = point.avgScore;
    } else {
      entry[point.competitorId] = point.avgScore;
    }
  }

  const data = Array.from(dateMap.values()).sort(
    (a, b) => String(a.date).localeCompare(String(b.date))
  );

  const CustomTooltip = ({ active, payload, label }: any) => {
    if (!active || !payload?.length) return null;
    return (
      <div style={{
        background: "var(--bg-2, #111827)",
        border: "1px solid rgba(15,23,42,0.12)",
        borderRadius: 10,
        padding: "10px 14px",
        fontSize: 12,
      }}>
        <p style={{ color: "var(--text-3, #4b5568)", marginBottom: 6 }}>{label}</p>
        {payload.map((p: any) => (
          <div key={p.dataKey} style={{ display: "flex", justifyContent: "space-between", gap: 16, marginBottom: 3 }}>
            <span style={{ color: p.color }}>{p.name}</span>
            <span style={{ color: "#0f172a", fontWeight: 600 }}>{p.value}</span>
          </div>
        ))}
      </div>
    );
  };

  return (
    <ResponsiveContainer width="100%" height={220}>
      <LineChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: -20 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="rgba(15,23,42,0.06)" />
        <XAxis
          dataKey="date"
          tick={{ fill: "#4b5568", fontSize: 11 }}
          axisLine={{ stroke: "rgba(15,23,42,0.06)" }}
          tickLine={false}
        />
        <YAxis
          domain={[0, 100]}
          tick={{ fill: "#4b5568", fontSize: 11 }}
          axisLine={false}
          tickLine={false}
        />
        <Tooltip content={<CustomTooltip />} />
        <Legend
          wrapperStyle={{ fontSize: 12, paddingTop: 12 }}
          formatter={(value, entry) => (
            <span style={{ color: (entry as any).color }}>{value}</span>
          )}
        />
        {/* Reference lines for grade thresholds */}
        <ReferenceLine y={85} stroke="rgba(52,211,153,0.15)" strokeDasharray="4 4" />
        <ReferenceLine y={70} stroke="rgba(96,165,250,0.15)" strokeDasharray="4 4" />
        <ReferenceLine y={55} stroke="rgba(251,191,36,0.12)" strokeDasharray="4 4" />

        {/* Client line */}
        <Line
          type="monotone"
          dataKey="client"
          name="Client"
          stroke={CLIENT_COLOR}
          strokeWidth={2.5}
          dot={{ fill: CLIENT_COLOR, r: 4, strokeWidth: 0 }}
          activeDot={{ r: 6, fill: CLIENT_COLOR }}
        />

        {/* Competitor lines */}
        {competitors.map((c) => (
          <Line
            key={c.id}
            type="monotone"
            dataKey={c.id}
            name={c.name}
            stroke={competitorColors[c.colorIndex]}
            strokeWidth={1.8}
            strokeDasharray="5 3"
            dot={{ fill: competitorColors[c.colorIndex], r: 3, strokeWidth: 0 }}
            activeDot={{ r: 5 }}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

function formatDate(d: Date): string {
  return new Date(d).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

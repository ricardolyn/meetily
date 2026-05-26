'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { liveNotesService, type LiveNotesSettings } from '@/services/liveNotesService';

const INTERVAL_OPTIONS = [
  { value: 30, label: 'Every 30 seconds' },
  { value: 60, label: 'Every 1 minute' },
  { value: 120, label: 'Every 2 minutes' },
  { value: 300, label: 'Every 5 minutes' },
  { value: 600, label: 'Every 10 minutes' },
] as const;

const PROVIDER_OPTIONS = [
  { value: 'inherit', label: 'Same as saved summary' },
  { value: 'ollama', label: 'Ollama (local)' },
  { value: 'claude', label: 'Claude' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'groq', label: 'Groq' },
  { value: 'openrouter', label: 'OpenRouter' },
  { value: 'builtin', label: 'Built-in AI (local)' },
] as const;

export function LiveNotesSettings() {
  const [settings, setSettings] = useState<LiveNotesSettings | null>(null);

  useEffect(() => {
    liveNotesService.getSettings().then(setSettings);
  }, []);

  async function update(patch: Partial<LiveNotesSettings>) {
    if (!settings) return;
    const prev = settings;
    const next = { ...settings, ...patch };
    setSettings(next);
    try {
      await liveNotesService.setSettings(next);
    } catch (e) {
      // Roll back the optimistic UI update so the on-screen value matches
      // what's actually on disk.
      setSettings(prev);
      toast.error(e instanceof Error ? e.message : 'Failed to save settings');
    }
  }

  if (!settings) {
    return <p className="text-sm text-gray-500">Loading…</p>;
  }

  return (
    <section className="space-y-4 py-4">
      <header>
        <h3 className="text-base font-semibold">Live notes</h3>
        <p className="text-sm text-gray-600 mt-1">
          Show a floating panel during recording with what&apos;s being discussed
          right now, questions asked of you, and a running list of action items.
          You can override the default per meeting from the recording controls.
        </p>
      </header>

      <div className="flex items-center justify-between">
        <Label className="font-normal">Run automatically when recording</Label>
        <Switch
          checked={settings.enabledByDefault}
          onCheckedChange={v => update({ enabledByDefault: v })}
        />
      </div>

      <div className="flex items-center justify-between gap-4">
        <div>
          <Label className="font-normal">Refresh interval</Label>
          <p className="text-xs text-gray-500 mt-0.5">
            Changes apply to the next recording.
          </p>
        </div>
        <Select
          value={String(settings.intervalSeconds)}
          onValueChange={v => update({ intervalSeconds: Number(v) as LiveNotesSettings['intervalSeconds'] })}
        >
          <SelectTrigger className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {INTERVAL_OPTIONS.map(opt => (
              <SelectItem key={opt.value} value={String(opt.value)}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex items-center justify-between gap-4">
        <Label className="font-normal">Model</Label>
        <Select
          value={settings.provider}
          onValueChange={v => update({ provider: v as LiveNotesSettings['provider'], model: v === 'inherit' ? null : settings.model })}
        >
          <SelectTrigger className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PROVIDER_OPTIONS.map(opt => (
              <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {settings.provider !== 'inherit' && (
        <div className="flex items-center justify-between gap-4">
          <Label className="font-normal">Model name</Label>
          <input
            className="w-48 h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-sm"
            placeholder="e.g. llama3:8b"
            value={settings.model ?? ''}
            onChange={e => update({ model: e.target.value || null })}
          />
        </div>
      )}
    </section>
  );
}

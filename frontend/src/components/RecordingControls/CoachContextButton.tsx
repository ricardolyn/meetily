'use client';

import { useState } from 'react';
import { NotebookPen } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useCoachContext } from '@/contexts/CoachContext';

interface Props {
  disabled?: boolean;
}

/**
 * Pre-recording button for writing the Coach's context. When context is set,
 * the Coach tab opens automatically once recording starts.
 */
export function CoachContextButton({ disabled = false }: Props) {
  const { context, setContext } = useCoachContext();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const hasContext = context.trim().length > 0;

  const openDialog = () => {
    setDraft(context);
    setOpen(true);
  };

  const save = () => {
    setContext(draft);
    setOpen(false);
  };

  return (
    <>
      <button
        type="button"
        onClick={openDialog}
        disabled={disabled}
        className="inline-flex items-center gap-1.5 px-4 py-2 bg-white/90 rounded-full shadow-sm border border-gray-200 text-xs font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-50"
        title="Notes for the Coach about this call"
      >
        <NotebookPen className="w-4 h-4 text-gray-500" />
        <span>Context</span>
        {hasContext && <span className="w-1.5 h-1.5 rounded-full bg-blue-500" />}
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Context for this call</DialogTitle>
            <DialogDescription>
              The Coach uses this to suggest what to say: who you&apos;re talking to, your goal,
              and background like a job description, your CV, or the agenda. It&apos;s kept for
              next time.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={draft}
            onChange={e => setDraft(e.target.value)}
            rows={12}
            placeholder="e.g. Interview for a Staff Engineer role at Acme. They care about distributed systems and mentoring. My strengths: led the payments migration, grew a team of 6…"
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDraft('')} disabled={!draft}>
              Clear
            </Button>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={save}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

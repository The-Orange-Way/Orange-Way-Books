import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Calendar, Loader2 } from 'lucide-react';

interface CalendarData {
  dateFormat: string;
  fiscalYearStart: string;
}

interface Props {
  data: CalendarData;
  onChange: (d: CalendarData) => void;
  onNext: () => void;
  onBack: () => void;
  saving?: boolean;
  progressMessage?: string;
  progressDetail?: string;
}

const dateFormats = [
  { value: 'MM-DD-YYYY', label: 'MM-DD-YYYY' },
  { value: 'DD-MM-YYYY', label: 'DD-MM-YYYY' },
  { value: 'YYYY-MM-DD', label: 'YYYY-MM-DD' },
];

const months = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

export default function StepCalendar({ data, onChange, onNext, onBack, saving, progressMessage, progressDetail }: Props) {
  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2 mb-1">
        <Calendar className="w-5 h-5 text-primary" />
        <h3 className="text-base font-semibold text-card-foreground">Calendar & Fiscal Year</h3>
      </div>
      <p className="text-sm text-muted-foreground">
        Set your preferred date format and when your fiscal year starts.
      </p>

      <div className="space-y-4">
        <div className="space-y-2">
          <Label>Date Format</Label>
          <Select value={data.dateFormat} onValueChange={(v) => onChange({ ...data, dateFormat: v })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {dateFormats.map((f) => <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label>Fiscal Year Starts</Label>
          <Select value={data.fiscalYearStart} onValueChange={(v) => onChange({ ...data, fiscalYearStart: v })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {months.map((m) => (
                <SelectItem key={m} value={m}>{m.charAt(0).toUpperCase() + m.slice(1)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {saving && progressMessage && (
        <div className="rounded-md border border-primary/20 bg-primary/5 p-3 flex items-start gap-3">
          <Loader2 className="w-4 h-4 text-primary animate-spin mt-0.5 shrink-0" />
          <div className="space-y-0.5 min-w-0">
            <p className="text-sm font-medium text-foreground">{progressMessage}</p>
            {progressDetail && (
              <p className="text-xs text-muted-foreground">{progressDetail}</p>
            )}
            <p className="text-xs text-muted-foreground/80">Your vault password is encrypting everything in this browser tab. The server only ever sees ciphertext. Please don't close this tab.</p>
          </div>
        </div>
      )}

      <div className="flex gap-3">
        <Button type="button" variant="outline" onClick={onBack} className="flex-1" disabled={saving}>Back</Button>
        <Button type="button" onClick={onNext} className="flex-1" disabled={saving}>
          {saving ? 'Creating…' : 'Create Organization'}
        </Button>
      </div>
    </div>
  );
}

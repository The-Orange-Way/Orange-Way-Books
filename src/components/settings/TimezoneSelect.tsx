import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { timezoneOptionsIncluding } from '@/lib/timezones';

export interface TimezoneSelectProps {
  /** The stored IANA zone. An empty string means the customer has none set. */
  value: string;
  onValueChange: (zone: string) => void;
  /** Passed to the trigger, so the caller keeps control of width. */
  className?: string;
  /** Passed to the trigger as data-testid. */
  testId?: string;
}

/**
 * The timezone picker for a settings screen.
 *
 * It reads the curated list from src/lib/timezones.ts rather than carrying its
 * own, which is the whole point of the module: a second list drifts, and a
 * zone stored by one surface then has no option to match on the other.
 *
 * It also guarantees the stored zone is in the list it renders. The curated
 * list is short and most of the world is not on it, and a Radix trigger whose
 * value matches no item renders empty, so without this a customer whose zone
 * is Europe/Madrid reads "no timezone set" while one is set. The extra option
 * is labelled "current" rather than onboarding's "detected", because here it
 * is the value the customer already saved and nothing detected it.
 */
export function TimezoneSelect({ value, onValueChange, className, testId }: TimezoneSelectProps) {
  const options = timezoneOptionsIncluding(value, 'current');

  return (
    <Select value={value} onValueChange={onValueChange}>
      <SelectTrigger className={className} data-testid={testId}>
        <SelectValue placeholder="No timezone set" />
      </SelectTrigger>
      <SelectContent>
        {options.map((tz) => (
          <SelectItem key={tz.value} value={tz.value}>
            {tz.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export default TimezoneSelect;

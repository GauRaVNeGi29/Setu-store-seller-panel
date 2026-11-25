/**
 * A row of five stars showing a rating out of 5. Whole numbers for a single
 * review; an average can be fractional (4.5 fills four and a half). Read
 * aloud as "4.5 out of 5 stars".
 */
const STAR = "M12 2.6l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 17.4l-5.8 3.1 1.1-6.5L2.6 9.4l6.5-.9z";

const Row = ({ size }: { size: number }) => (
  <svg viewBox="0 0 120 24" width={size * 5} height={size} aria-hidden="true" focusable="false">
    {[0, 1, 2, 3, 4].map((i) => <path key={i} d={STAR} transform={`translate(${i * 24} 0)`} />)}
  </svg>
);

export function Stars({ value, size = 18 }: { value: number; size?: number }) {
  const v = Math.max(0, Math.min(5, value));
  const label = `${Number.isInteger(v) ? v : v.toFixed(1)} out of 5 stars`;
  return (
    <span className="vp-stars" role="img" aria-label={label} style={{ width: size * 5, height: size }}>
      <Row size={size} />
      <span className="vp-stars-on" style={{ width: `${(v / 5) * 100}%` }}><Row size={size} /></span>
    </span>
  );
}

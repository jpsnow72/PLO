// The APPROXIMATION badge is implemented with the rest of the badge
// family in AccuracyBadge.tsx — deliberately one implementation, so
// the certified-GTO (solid green) and approximation (amber outline)
// families can never drift apart visually. This module re-exports it
// under the path the Starting Hands page imports; the component takes
// the same optional `label` prop (default 'APPROXIMATION').

export { ApproximationBadge } from './AccuracyBadge';

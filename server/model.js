// Shared vocabulary. The ORDER of these lists is part of the code format:
// changing an order or inserting in the middle breaks every code already handed out.
// To add cities, append to LOCATIONS and bump the code version (see SETUP.md).

export const LOCATIONS = [
  { name: 'Madrid', country: 'ES', cluster: 'madrid' },
  { name: 'Barcelona', country: 'ES', cluster: 'barcelona' },
  { name: 'Valencia', country: 'ES', cluster: 'valencia' },
  { name: 'Malaga', country: 'ES', cluster: 'malaga' },
  { name: 'Other city in Spain', country: 'ES', cluster: null },
  { name: 'Amsterdam', country: 'NL', cluster: 'randstad' },
  { name: 'Rotterdam', country: 'NL', cluster: 'randstad' },
  { name: 'The Hague', country: 'NL', cluster: 'randstad' },
  { name: 'Eindhoven', country: 'NL', cluster: 'eindhoven' },
  { name: 'Other city in the Netherlands', country: 'NL', cluster: null },
  { name: 'Somewhere else', country: 'XX', cluster: null },
];

export const BAND_LABELS = ['12-13', '14-15', '16-17', '18+']; // stored as 1..4, 0 means no child
export const LIFE_STAGES = ['Newly arrived', 'Settled in', 'Long-term resident', 'About to move', 'Prefer not to say'];
export const FAMILY = ['Two-parent', 'Single parent', 'Co-parenting after divorce', 'Blended', 'Other', 'Prefer not to say'];
export const LIFE_PNS = 4;
export const FAMILY_PNS = 5;

export const MODES = ['smart', 'random', 'country', 'city', 'age', 'life', 'family'];
export const MIN_ROOM_SIZE = 2;
export const MAX_ROOM_SIZE = 10;
export const MAX_ROOMS = 50; // Zoom's limit for createBreakoutRooms

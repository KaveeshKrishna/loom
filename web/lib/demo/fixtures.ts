/**
 * web/lib/demo/fixtures.ts
 *
 * Builds a complete fabricated Loom "world" — folder tree, users, ACL
 * rules, audit log, trash, notifications, scan job history. Nothing here
 * is real; every name/timestamp/size is invented. Called once by state.ts
 * on first load (or after "Reset demo").
 */
import { pickPhotoAsset, pickVideoAsset } from "./assets";
import {
  DemoWorld,
  DemoFileNode,
  DemoUser,
  DemoAclRule,
  DemoAuditLog,
  DemoTrashItem,
  DemoNotification,
  DemoScanJob,
  DEMO_OWNER_ID,
} from "./types";

let idCounter = 0;
function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

function daysAgo(n: number, hour = 12, min = 0): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(hour, min, 0, 0);
  return d.toISOString();
}

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
function pick<T>(arr: T[]): T {
  return arr[randInt(0, arr.length - 1)];
}

// ─── Name pools ─────────────────────────────────────────────────────────────

const PHOTO_NAMES = [
  "Sunset at the Beach", "Mountain Hike", "Family Dinner", "Birthday Cake",
  "Golden Retriever Puppy", "City Skyline at Night", "Autumn Leaves",
  "Snowy Morning", "Beach Volleyball", "Campfire Evening", "Garden in Bloom",
  "Road Trip Views", "Lakeside Picnic", "Old Town Streets", "Coffee and Croissant",
  "Rainy Window", "Fireworks Display", "Farmers Market", "Waterfall Hike",
  "Cherry Blossoms", "New Year's Eve", "Backyard BBQ", "Foggy Harbor",
  "Desert Sunrise", "Ice Cream Cone", "Vineyard Tour", "Kids at the Park",
  "Rooftop View", "Wildflower Field", "Christmas Morning", "Graduation Day",
  "Karaoke Night", "Ferry Ride", "Museum Visit", "Street Art", "Night Market",
  "Cabin in the Woods", "Boardwalk Sunset", "Farm Animals", "Balloon Festival",
  "Skiing Trip", "Tide Pools", "Concert Lights", "Home Renovation",
  "Baking Day", "Puppy's First Bath", "Stargazing", "Picnic Basket",
  "Autumn Pumpkins", "Lighthouse View",
];

const VIDEO_NAMES = [
  "Vacation Highlights", "Birthday Party", "First Steps", "Family Reunion",
  "Graduation Ceremony", "Beach Day", "Camping Trip", "Wedding Toast",
  "Puppy Playtime", "Talent Show", "Road Trip Timelapse", "Fireworks Show",
];

const DOC_NAMES = [
  { name: "Resume", ext: "pdf" },
  { name: "Tax Return 2024", ext: "pdf" },
  { name: "Budget Spreadsheet", ext: "txt" },
  { name: "Meeting Notes", ext: "md" },
  { name: "Lease Agreement", ext: "pdf" },
  { name: "Recipe Collection", ext: "txt" },
  { name: "Travel Itinerary", ext: "pdf" },
  { name: "Project Proposal", ext: "md" },
  { name: "Insurance Policy", ext: "pdf" },
  { name: "Reading List", ext: "txt" },
  { name: "Warranty Card", ext: "pdf" },
  { name: "Grocery List", ext: "txt" },
  { name: "Book Draft Chapter 1", ext: "md" },
  { name: "Car Manual", ext: "pdf" },
  { name: "Workout Plan", ext: "txt" },
  { name: "Quarterly Report", ext: "pdf" },
  { name: "Song Lyrics", ext: "txt" },
  { name: "Passport Scan", ext: "pdf" },
  { name: "Moving Checklist", ext: "md" },
  { name: "Garden Planner", ext: "txt" },
];

const IMAGE_MIME: Record<string, string> = { jpg: "image/jpeg", png: "image/png" };
const DOC_MIME: Record<string, string> = {
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
};

function contentIdentityForPhoto(seed: string): DemoFileNode["contentIdentity"] {
  const asset = pickPhotoAsset(seed);
  return {
    id: nextId("ci"),
    size: String(randInt(1_200_000, 6_500_000)),
    fastHash: nextId("hash"),
    thumbnail: { id: nextId("thumb"), cachePath: asset, width: 320, height: 320 },
    preview: { id: nextId("preview"), cachePath: asset, width: 1920, height: 1080 },
    videoCaches: [],
  };
}

function contentIdentityForVideo(seed: string): DemoFileNode["contentIdentity"] {
  const asset = pickVideoAsset(seed);
  return {
    id: nextId("ci"),
    size: String(randInt(15_000_000, 480_000_000)),
    fastHash: nextId("hash"),
    thumbnail: null,
    preview: { id: nextId("preview"), cachePath: asset, width: 1280, height: 720 },
    videoCaches: [{ id: nextId("vc"), durationSeconds: randInt(8, 240) }],
  };
}

function makeDirNode(relativePath: string, name: string): DemoFileNode {
  return {
    id: nextId("dir"),
    relativePath,
    name,
    type: "DIRECTORY",
    mimeType: null,
    size: null,
    modifiedAt: daysAgo(randInt(30, 400)),
    updatedAt: daysAgo(randInt(0, 30)),
    indexedAt: daysAgo(randInt(30, 400)),
    isVisible: true,
    sourceVersion: null,
    browserCompatible: null,
    healthStatus: "HEALTHY",
    healthError: null,
    inTrash: false,
    contentIdentityId: null,
    contentIdentity: null,
  };
}

function makePhotoNode(dir: string, displayName: string, ext: "jpg" | "png" = "jpg"): DemoFileNode {
  const relativePath = dir ? `${dir}/${displayName}.${ext}` : `${displayName}.${ext}`;
  const ci = contentIdentityForPhoto(relativePath);
  return {
    id: nextId("file"),
    relativePath,
    name: `${displayName}.${ext}`,
    type: "FILE",
    mimeType: IMAGE_MIME[ext],
    size: ci!.size,
    modifiedAt: daysAgo(randInt(0, 400)),
    updatedAt: daysAgo(randInt(0, 30)),
    indexedAt: daysAgo(randInt(0, 400)),
    isVisible: true,
    sourceVersion: `${ci!.size}-${Date.now()}`,
    browserCompatible: null,
    healthStatus: "HEALTHY",
    healthError: null,
    inTrash: false,
    contentIdentityId: ci!.id,
    contentIdentity: ci,
  };
}

function makeVideoNode(dir: string, displayName: string, ext: "mp4" | "mov" = "mp4"): DemoFileNode {
  const relativePath = dir ? `${dir}/${displayName}.${ext}` : `${displayName}.${ext}`;
  const ci = contentIdentityForVideo(relativePath);
  const mimeType = ext === "mov" ? "video/quicktime" : "video/mp4";
  return {
    id: nextId("file"),
    relativePath,
    name: `${displayName}.${ext}`,
    type: "FILE",
    mimeType,
    size: ci!.size,
    modifiedAt: daysAgo(randInt(0, 400)),
    updatedAt: daysAgo(randInt(0, 30)),
    indexedAt: daysAgo(randInt(0, 400)),
    isVisible: true,
    sourceVersion: `${ci!.size}-${Date.now()}`,
    browserCompatible: true,
    healthStatus: "HEALTHY",
    healthError: null,
    inTrash: false,
    contentIdentityId: ci!.id,
    contentIdentity: ci,
  };
}

function makeDocNode(dir: string, displayName: string, ext: string): DemoFileNode {
  const relativePath = dir ? `${dir}/${displayName}.${ext}` : `${displayName}.${ext}`;
  return {
    id: nextId("file"),
    relativePath,
    name: `${displayName}.${ext}`,
    type: "FILE",
    mimeType: DOC_MIME[ext] ?? "application/octet-stream",
    size: String(randInt(4_000, 900_000)),
    modifiedAt: daysAgo(randInt(0, 400)),
    updatedAt: daysAgo(randInt(0, 30)),
    indexedAt: daysAgo(randInt(0, 400)),
    isVisible: true,
    sourceVersion: `${randInt(1000, 9999)}-${Date.now()}`,
    browserCompatible: null,
    healthStatus: "HEALTHY",
    healthError: null,
    inTrash: false,
    contentIdentityId: null,
    contentIdentity: null,
  };
}

function makeBrokenNode(dir: string, displayName: string, status: "CORRUPT" | "UNSUPPORTED"): DemoFileNode {
  const ext = status === "CORRUPT" ? "mp4" : "raw";
  const relativePath = `${dir}/${displayName}.${ext}`;
  return {
    id: nextId("file"),
    relativePath,
    name: `${displayName}.${ext}`,
    type: "FILE",
    mimeType: status === "CORRUPT" ? "video/mp4" : "image/x-raw",
    size: String(randInt(500_000, 4_000_000)),
    modifiedAt: daysAgo(randInt(10, 200)),
    updatedAt: daysAgo(randInt(0, 10)),
    indexedAt: daysAgo(randInt(10, 200)),
    isVisible: true,
    sourceVersion: `${randInt(1000, 9999)}-${Date.now()}`,
    browserCompatible: status === "CORRUPT" ? false : null,
    healthStatus: status,
    healthError:
      status === "CORRUPT"
        ? "moov atom not found (file appears truncated)"
        : "RAW format not supported by the current generation pipeline",
    inTrash: false,
    contentIdentityId: null,
    contentIdentity: null,
  };
}

// ─── World builder ──────────────────────────────────────────────────────────

export function buildFixtures(): DemoWorld {
  idCounter = 0;
  const nodes: DemoFileNode[] = [];

  // ── Folder tree ──
  const folders = [
    ["Photos", "Photos"],
    ["Photos/Vacation 2024", "Vacation 2024"],
    ["Photos/Family", "Family"],
    ["Photos/Pets", "Pets"],
    ["Videos", "Videos"],
    ["Documents", "Documents"],
    ["Work", "Work"],
    ["Misc", "Misc"],
  ];
  for (const [rel, name] of folders) nodes.push(makeDirNode(rel, name));

  // ── Photos (~50, spread across the three photo subfolders) ──
  const photoDirs = ["Photos/Vacation 2024", "Photos/Family", "Photos/Pets"];
  const shuffledPhotoNames = [...PHOTO_NAMES];
  shuffledPhotoNames.forEach((baseName, i) => {
    const dir = photoDirs[i % photoDirs.length];
    const useImgStyle = i % 4 === 0;
    const displayName = useImgStyle ? `IMG_${2000 + i}` : baseName;
    nodes.push(makePhotoNode(dir, displayName, i % 7 === 0 ? "png" : "jpg"));
  });

  // ── Videos (~12) ──
  VIDEO_NAMES.forEach((baseName, i) => {
    nodes.push(makeVideoNode("Videos", baseName, i % 5 === 0 ? "mov" : "mp4"));
  });

  // ── Documents (~20, split between Documents/ and Work/) ──
  DOC_NAMES.forEach((doc, i) => {
    const dir = i % 3 === 0 ? "Work" : "Documents";
    nodes.push(makeDocNode(dir, doc.name, doc.ext));
  });

  // ── Misc folder: a small mixed bag ──
  nodes.push(makePhotoNode("Misc", "Screenshot 2024-11-02"));
  nodes.push(makeDocNode("Misc", "Random Notes", "txt"));
  nodes.push(makeVideoNode("Misc", "Screen Recording"));

  // ── File Health: a couple of broken entries ──
  nodes.push(makeBrokenNode("Videos", "_1102011", "CORRUPT"));
  nodes.push(makeBrokenNode("Photos/Vacation 2024", "DSC_0447", "UNSUPPORTED"));

  // ── Users ──
  const users: DemoUser[] = [
    { id: DEMO_OWNER_ID, name: "Demo Owner", email: "demo@example.com", role: "OWNER", createdAt: daysAgo(400) },
    { id: nextId("user"), name: "Alex Rivera", email: "alex@example.com", role: "FAMILY", createdAt: daysAgo(180) },
    { id: nextId("user"), name: "Jamie Chen", email: "jamie@example.com", role: "FAMILY", createdAt: daysAgo(60) },
  ];
  const [, alex, jamie] = users;

  // ── ACL rules ──
  const aclRules: DemoAclRule[] = [
    { id: nextId("acl"), userId: alex.id, path: "Work", allow: false },
    { id: nextId("acl"), userId: alex.id, path: "Photos", allow: true },
    { id: nextId("acl"), userId: jamie.id, path: "Documents", allow: false },
    { id: nextId("acl"), userId: jamie.id, path: "Photos/Family", allow: true },
    { id: nextId("acl"), userId: jamie.id, path: "Videos", allow: true },
  ];

  // ── Audit log (~25 entries, spread over the last couple weeks) ──
  const actions: { action: string; details: Record<string, unknown> }[] = [
    { action: "UPLOAD", details: { originalName: "Sunset at the Beach.jpg", finalPath: "Photos/Vacation 2024/Sunset at the Beach.jpg", size: 3400000 } },
    { action: "RENAME", details: { source: "Misc/Untitled.txt", dest: "Misc/Random Notes.txt" } },
    { action: "TRASH", details: { path: "Documents/Old Draft.txt" } },
    { action: "RESTORE", details: { path: "Photos/Family/Reunion 2023.jpg" } },
    { action: "MOVE", details: { source: "Misc/Screenshot.png", dest: "Photos/Screenshot.png" } },
    { action: "COPY", details: { source: "Documents/Resume.pdf", dest: "Work/Resume.pdf" } },
    { action: "MKDIR", details: { path: "Photos/Pets" } },
    { action: "USER_CREATED", details: { targetEmail: "jamie@example.com" } },
    { action: "EMPTY_TRASH", details: { count: 3, total: 3 } },
    { action: "PERMANENT_DELETE", details: { originalPath: "Misc/Old Scan.pdf" } },
  ];
  const auditLogs: DemoAuditLog[] = [];
  for (let i = 0; i < 25; i++) {
    const a = pick(actions);
    auditLogs.push({
      id: nextId("audit"),
      userId: i % 6 === 0 ? alex.id : DEMO_OWNER_ID,
      action: a.action,
      details: a.details,
      timestamp: daysAgo(randInt(0, 21), randInt(7, 22), randInt(0, 59)),
    });
  }
  auditLogs.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));

  // ── Trash (a handful of already-trashed fabricated items) ──
  const trashItems: DemoTrashItem[] = [];
  const trashSeed: [string, string][] = [
    ["Documents/Old Draft.txt", "txt"],
    ["Photos/Misc/Blurry Shot.jpg", "jpg"],
    ["Work/Draft Report.pdf", "pdf"],
  ];
  for (const [originalPath, ext] of trashSeed) {
    const name = originalPath.split("/").pop()!;
    const isImage = ext === "jpg";
    const trashNode: DemoFileNode = isImage
      ? makePhotoNode("", name.replace(/\.jpg$/, ""))
      : makeDocNode("", name.replace(/\.\w+$/, ""), ext);
    trashNode.relativePath = `.LoomTrash/${nextId("trash")}_${name}`;
    trashNode.inTrash = true;
    nodes.push(trashNode);
    trashItems.push({
      id: nextId("trashitem"),
      fileNodeId: trashNode.id,
      originalPath,
      trashPath: trashNode.relativePath.replace(".LoomTrash/", ""),
      deletedAt: daysAgo(randInt(1, 10)),
      expiresAt: daysAgo(-randInt(5, 14)), // in the future
      deletedByUserId: DEMO_OWNER_ID,
    });
  }

  // ── Notifications ──
  const notifications: DemoNotification[] = [
    {
      id: nextId("notif"),
      userId: DEMO_OWNER_ID,
      type: "OPERATION_FAILED",
      title: "Upload interrupted",
      message: "A previous upload of 'Vacation Highlights.mp4' didn't complete and was cleaned up.",
      read: false,
      createdAt: daysAgo(2),
    },
    {
      id: nextId("notif"),
      userId: DEMO_OWNER_ID,
      type: "UPLOAD_FAILED",
      title: "Rescan complete",
      message: "Library rescan finished — 0 new files found.",
      read: false,
      createdAt: daysAgo(5),
    },
    {
      id: nextId("notif"),
      userId: DEMO_OWNER_ID,
      type: "OPERATION_FAILED",
      title: "Welcome to the Loom demo",
      message: "Everything you see is fabricated — explore freely.",
      read: true,
      createdAt: daysAgo(30),
    },
  ];

  // ── Scan job history ──
  const scanJobs: DemoScanJob[] = [
    {
      id: nextId("scan"),
      type: "FULL_RESCAN",
      status: "COMPLETED",
      requestedAt: daysAgo(1),
      startedAt: daysAgo(1),
      completedAt: daysAgo(1),
      error: null,
      processedFiles: nodes.length,
      totalFiles: nodes.length,
    },
    {
      id: nextId("scan"),
      type: "FULL_RESCAN",
      status: "COMPLETED",
      requestedAt: daysAgo(8),
      startedAt: daysAgo(8),
      completedAt: daysAgo(8),
      error: null,
      processedFiles: nodes.length - 4,
      totalFiles: nodes.length - 4,
    },
  ];

  return {
    version: 1,
    nodes,
    users,
    aclRules,
    auditLogs,
    trashItems,
    notifications,
    favorites: [],
    scanJobs,
    scannerStatus: "idle",
    videoCacheStats: { usedBytes: 2_400_000_000, limitBytes: 20 * 1024 * 1024 * 1024, cachedVideos: VIDEO_NAMES.length },
    thumbCacheStats: { thumbCount: 50, previewCount: 62, physicalFiles: 112 },
  };
}

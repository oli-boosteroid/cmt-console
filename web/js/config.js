/* CMT Console - start-up data store. Every list starts empty and is filled from the server
   (hydrateLive). issueTags / testingTags are the tag vocabularies used by the Send Issue, Testing
   and tag pickers; variables are the default links (Admin > Content overrides them). */
window.DATA = {
  "me": {
    "name": "",
    "initials": "",
    "role": ""
  },
  "reads": {},
  "team": [],
  "templates": [],
  "variables": [
    {
      "id": "fb_group",
      "label": "Facebook group link",
      "value": "https://facebook.com/groups/boosteroid"
    },
    {
      "id": "help_center",
      "label": "Help center URL",
      "value": "https://help.boosteroid.com"
    },
    {
      "id": "status_page",
      "label": "Status page URL",
      "value": "https://status.boosteroid.com"
    }
  ],
  "activity": [],
  "feedback": [],
  "handoffs": [],
  "mods": [],
  "ignoredReddit": [],
  "moderatorsDiscord": [],
  "moderatorsReddit": [],
  "users": [],
  "redditModmail": [],
  "modNotes": {},
  "discordTickets": [],
  "jira": [],
  "redditPosts": [],
  "facebookPosts": [],
  "discordActivity": [],
  "channelContacts": [],
  "notes": [],
  "issueTags": [
    "Android Application",
    "Android TV",
    "Bitrate",
    "Boosteroid Gamepad",
    "Boosteroid PWA",
    "Browser",
    "Game FPS",
    "Game availability",
    "Game maintenance",
    "Game update",
    "Gamepad",
    "Hisense TV (VIDAA)",
    "Image quality",
    "Issue on user's side",
    "Keyboard",
    "LG TV (webOS)",
    "Latency",
    "Launch issues",
    "Linux Application",
    "MacOS Application",
    "Microphone",
    "Mobile/Tablet",
    "Mouse",
    "NAT Strict",
    "No resources",
    "Other",
    "Peripheral",
    "Poor quality",
    "Queue",
    "Reported to L2",
    "Resolution",
    "Samsung TV (Tizen)",
    "Saves",
    "Service maintenance",
    "Session crash",
    "Sound",
    "Stream FPS",
    "Streaming",
    "Windows Application",
    "Xbox SSO",
    "iOS/Safari"
  ],
  "testingTags": [
    "Bitrate issues",
    "Game availability",
    "Game crash",
    "Game launch issue",
    "Game update",
    "Gamepad",
    "Known issues problem",
    "Launcher issue",
    "Other",
    "Resolution",
    "Session crash",
    "Session launch issue",
    "Unstable connection/stream"
  ],
  "reports": [],
  "maintenances": [],
  "maintenanceSubs": [],
  "discordForum": [],
  "discordMentions": [],
  "telegramMessages": [],
  "knownIssues": {
    "games": {
      "has_entity": true,
      "rows": []
    },
    "apps": {
      "has_entity": true,
      "rows": []
    },
    "session": {
      "has_entity": false,
      "rows": []
    },
    "account": {
      "has_entity": false,
      "rows": []
    }
  },
  "knownSuggestions": [],
  "schedule": {
    "months": []
  },
  "gameCards": {
    "weeks": [],
    "image_keys": []
  }
};

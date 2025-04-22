require("dotenv").config();
const fs = require("fs");
const readline = require("readline");
const { google } = require("googleapis");

// Configuration
const SCOPES = ["https://www.googleapis.com/auth/youtube.force-ssl"];
const TOKEN_PATH = "token.json";
const MAX_RESULTS = 100; // Max comments per API call
const BATCH_SIZE = 50; // Max comments to process at once
const youtubeChannelID = process.env.YOUTUBE_CHANNEL_ID;

// Authorization setup
async function authorize() {
    try {
        const credentials = JSON.parse(fs.readFileSync("credentials.json"));
        const { client_secret, client_id, redirect_uris } = credentials.installed;
        const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

        if (fs.existsSync(TOKEN_PATH)) {
            oAuth2Client.setCredentials(JSON.parse(fs.readFileSync(TOKEN_PATH)));
            return oAuth2Client;
        }

        return await getNewToken(oAuth2Client);
    } catch (error) {
        console.error("Authorization error:", error.message);
        process.exit(1);
    }
}

function getNewToken(oAuth2Client) {
    return new Promise((resolve, reject) => {
        const authUrl = oAuth2Client.generateAuthUrl({
            access_type: "offline",
            scope: SCOPES,
        });

        console.log("Authorize this app by visiting:", authUrl);
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });

        rl.question("Enter authorization code: ", (code) => {
            rl.close();
            oAuth2Client.getToken(code, (err, token) => {
                if (err) return reject(err);
                oAuth2Client.setCredentials(token);
                fs.writeFileSync(TOKEN_PATH, JSON.stringify(token));
                console.log("Token saved to", TOKEN_PATH);
                resolve(oAuth2Client);
            });
        });
    });
}

// Comment processing functions
async function fetchComments(auth, videoId) {
    const youtube = google.youtube({ version: "v3", auth });

    try {
        const response = await youtube.commentThreads.list({
            part: "snippet",
            videoId: videoId,
            maxResults: MAX_RESULTS,
        });

        return response.data.items
            .filter(item => isSpamComment(item.snippet.topLevelComment.snippet.textDisplay))
            .map(item => item.id);
    } catch (error) {
        console.error(`Error fetching comments for video ${videoId}:`, error.message);
        return [];
    }
}

function isSpamComment(text) {
    // Check for suspicious Unicode normalization
    if (text !== text.normalize("NFKD")) return true;
    
    // Check against blocked words list
    const blockedWords = JSON.parse(fs.readFileSync("blockedword.json"));
    const lowerText = text.toLowerCase();
    
    return blockedWords.some(word => lowerText.includes(word.toLowerCase()));
}

async function deleteComments(auth, commentIds) {
    if (commentIds.length === 0) return;

    const youtube = google.youtube({ version: "v3", auth });
    let processed = 0;

    while (commentIds.length > 0) {
        const batch = commentIds.splice(0, BATCH_SIZE);
        try {
            await youtube.comments.setModerationStatus({
                id: batch,
                moderationStatus: "rejected"
            });
            processed += batch.length;
            console.log(`Deleted ${processed}/${commentIds.length + processed} comments`);
        } catch (error) {
            console.error(`Failed to delete batch:`, error.message);
        }
    }
}

// Video listing function
async function getChannelVideos(auth) {
    const youtube = google.youtube({ version: "v3", auth });

    try {
        const response = await youtube.channels.list({
            part: "contentDetails",
            id: youtubeChannelID,
        });

        const uploadsPlaylistId = response.data.items[0].contentDetails.relatedPlaylists.uploads;
        const videos = [];
        let nextPageToken = "";

        do {
            const playlistResponse = await youtube.playlistItems.list({
                part: "snippet",
                playlistId: uploadsPlaylistId,
                maxResults: 50,
                pageToken: nextPageToken,
            });
            videos.push(...playlistResponse.data.items);
            nextPageToken = playlistResponse.data.nextPageToken;
        } while (nextPageToken);

        return videos;
    } catch (error) {
        console.error("Error fetching videos:", error.message);
        return [];
    }
}

// Main execution
(async () => {
    try {
        console.log("🚀 Starting spam comment removal process");
        const auth = await authorize();
        const videos = await getChannelVideos(auth);

        for (const video of videos) {
            console.log(`\n🔍 Checking video: ${video.snippet.title}`);
            const spamComments = await fetchComments(auth, video.snippet.resourceId.videoId);
            
            if (spamComments.length > 0) {
                console.log(`⚠️ Found ${spamComments.length} spam comments`);
                await deleteComments(auth, spamComments);
                console.log("✅ Spam comments removed");
            } else {
                console.log("✅ No spam found");
            }
        }
        
        console.log("\n✨ Process completed successfully");
    } catch (error) {
        console.error("❌ Error in main process:", error.message);
    }
})();

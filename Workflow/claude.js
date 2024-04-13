#!/usr/bin/osascript -l JavaScript

// Helpers
function envVar(varName) {
  return $.NSProcessInfo.processInfo.environment.objectForKey(varName).js
}

function fileExists(path) {
  return $.NSFileManager.defaultManager.fileExistsAtPath(path)
}

function fileModified(path) {
  return $.NSFileManager.defaultManager
    .attributesOfItemAtPathError(path, undefined)
    .js["NSFileModificationDate"].js
    .getTime()
}

function deleteFile(path) {
  return $.NSFileManager.defaultManager.removeItemAtPathError(path, undefined)
}

function writeFile(path, text) {
  $(text).writeToFileAtomicallyEncodingError(path, true, $.NSUTF8StringEncoding, undefined)
}

function readChat(path) {
  const chatString = $.NSString.stringWithContentsOfFileEncodingError(path, $.NSUTF8StringEncoding, undefined).js
  return JSON.parse(chatString)
}

function appendChat(path, message) {
  const ongoingChat = readChat(path).concat(message)
  const chatString = JSON.stringify(ongoingChat)
  writeFile(path, chatString)
}

// MARK: markdown chat

function markdownChat(messages, ignoreLastInterrupted = true) {
  return messages.reduce((accumulator, current, index, allMessages) => {
    if (current["role"] === "assistant")
      return `${accumulator}${current["content"]}\n\n`

    if (current["role"] === "user") {
      const userMessage = current["content"].split("\n").map(line => `### ${line}`).join("\n") // support multi-line questions (e.g. via External Trigger)
      const userTwice = allMessages[index + 1]?.["role"] === "user" // "user" role twice in a row
      const lastMessage = index === allMessages.length - 1 // "user is last message"

      return userTwice || (lastMessage && !ignoreLastInterrupted) ?
        `${accumulator}${userMessage}\n\n[Answer Interrupted]\n\n` :
        `${accumulator}${userMessage}\n\n`
    }

    // Ignore any other role
    return accumulator
  }, "")
}

// MARK: start stream

function startStream(apiEndpoint, apiKey, maxTokens, model, systemPrompt, ongoingChat, streamFile, pidStreamFile) {

  $.NSFileManager.defaultManager.createFileAtPathContentsAttributes(streamFile, undefined, undefined) // Create empty file

  const task = $.NSTask.alloc.init
  const stdout = $.NSPipe.pipe
  const messages = ongoingChat
  const data = JSON.stringify({ system: systemPrompt, model: model, messages: messages, max_tokens: maxTokens, stream: true }) // 256 // 1024 // 3072 // max: 4096

  task.executableURL = $.NSURL.fileURLWithPath("/usr/bin/curl")
  
  // Anthropic 
  task.arguments = [
    `${apiEndpoint}/v1/messages`,
    "--speed-limit", "0", "--speed-time", "5", // Abort stalled connection after a few seconds
    "--header", "anthropic-version: 2023-06-01",
    "--header", "anthropic-beta: messages-2023-12-15",
    "--header", "content-type: application/json",
    "--header", `x-api-key: ${apiKey}`,
    "--data", data,
    "--output", streamFile
  ]

  task.standardOutput = stdout
  task.launchAndReturnError(false)
  writeFile(pidStreamFile, task.processIdentifier.toString())
}

// MARK: read stream

function readStream(streamFile, chatFile, pidStreamFile) {

  const streamMarker = envVar("stream_marker") === "1"
  const streamString = $.NSString.stringWithContentsOfFileEncodingError(streamFile, $.NSUTF8StringEncoding, undefined).js

  // When starting a stream or continuing from a closed window, add a marker to determine the location of future replacements
  if (streamMarker) return JSON.stringify({
    rerun: 0.1,
    variables: { streaming_now: true },
    response: "…",
    behaviour: { response: "append" }
  })

  // If response looks like proper JSON, it is probably an error
  if (streamString.startsWith("{")) {
    try {
      const errorMessage = JSON.parse(streamString)["error"]["message"]

      if (errorMessage) {

        console.log(`Error message! ${errorMessage}`)

        // Delete stream files
        deleteFile(streamFile)
        deleteFile(pidStreamFile)

        return JSON.stringify({
          response: `[${errorMessage}]  \n(${(new Date).toUTCString()})`, // Surround in square brackets to look like other messages
          behaviour: { response: "replacelast" }
        });
      }

      throw "Could not determine error message" // Fallback to the catch
    } catch (error) {

      return JSON.stringify({
        response: `[Unexpected error occurred] ${error}  \n(${new Date().toUTCString()})`,
        behaviour: { response: "replacelast" }
      });
    }
  }

  //streamString = streamString.replace(/"\n\n/g, "\"[[NEWLINE]][[NEWLINE]]");
  //streamString = streamString.replace(/"\n/g, "\"[[NEWLINE]]");

  // Parse streaming response
  const chunks = streamString
    .split("\n") // Split into lines
    .map(item => item.replace(/^data: /, "")) // Remove extraneous leading "data: {..."
    .filter(item => item.startsWith("{"))     // Only grab lines which could be expected JSON
    .map(item => parseLine(item))             // Parse JSON ~~and restore newlines~~

  function parseLine(line) {
    try {
      //const json = JSON.parse(line.replace("[[NEWLINE]]", "\\n"))
      const json = JSON.parse(line)
      return json
    } catch (error) {
      //return JSON.parse(`{"delta":{"text":"🔴"}}`)
      return JSON.parse(`{"delta":{"text":" ..."}}`)
    }
  }

  const responseText = chunks.map(c => c?.delta?.text).join("")

  // If File not modified for over 5 seconds, connection stalled
  const stalled = new Date().getTime() - fileModified(streamFile) > 5000

  if (stalled) {
    // Write incomplete response
    if (responseText.length > 0) appendChat(chatFile, { role: "assistant", content: responseText })

    // Delete stream files
    deleteFile(streamFile)
    deleteFile(pidStreamFile)

    // Stop
    return JSON.stringify({
      response: `${responseText} [Connection Stalled]`,
      footer: "You can ask Claude to continue the answer",
      behaviour: { response: "replacelast", scroll: "end" }
    })
  }

  // If file is empty, we were too fast and will try again on next loop
  if (streamString.length === 0) return JSON.stringify({
    rerun: 0.1,
    variables: { streaming_now: true }
  })

  // Last token finish reason
  const finishReason = chunks.slice(-2)[0]?.delta?.stop_reason // Claude

  // If reponse is not finished, continue loop
  if (finishReason === undefined) return JSON.stringify({
    rerun: 0.1,
    variables: { streaming_now: true },
    response: responseText,
    behaviour: { response: "replacelast", scroll: "end" }
  });

  // When finished, write history and delete stream files
  appendChat(chatFile, { role: "assistant", content: responseText })
  deleteFile(streamFile)
  deleteFile(pidStreamFile)

  // Mention finish reason in footer
  const footerText = (function () {
    switch (finishReason) {
      case "max_tokens": return "Maximum number of output tokens reached" // claude
      //case "content_filter": return "Content was omitted due to a flag from OpenAI content filters"
      //default: return `"Finish-Reason: ${finishReason || "<undefined>"}"` // debug claude
    }
  })()

  // Stop
  return JSON.stringify({
    //variables: { streaming_now: false },
    response: responseText,
    footer: footerText,
    behaviour: { response: "replacelast", scroll: "end" }
  });
}


// MARK: main

function run(argv) {
  // Constant data
  const typedQuery = argv[0]
  const maxEntries = 100
  const apiKey = envVar("anthropic_api_key")
  const maxTokens = Number(envVar("claude_max_tokens")) || 512
  const apiEndpoint = envVar("claude_api_endpoint") || "https://api.anthropic.com"
  const systemPrompt = envVar("system_prompt")
  const model = envVar("claude_model_override") ? envVar("claude_model_override") : envVar("gpt_model")

  const chatFile = `${envVar("alfred_workflow_data")}/chat.json`
  const pidStreamFile = `${envVar("alfred_workflow_cache")}/pid.txt`
  const streamFile = `${envVar("alfred_workflow_cache")}/stream.txt`
  const streamingNow = envVar("streaming_now") === "1"

  // If continually reading from a stream, continue that loop
  if (streamingNow) return readStream(streamFile, chatFile, pidStreamFile)

  // Load previous conversation and cap to maximum size
  const previousChat = readChat(chatFile).slice(-maxEntries)

  // If "streaming_now" is unset but stream file exists, the window was closed mid-stream
  // Reload conversation and rerun to resume stream
  if (fileExists(streamFile)) return JSON.stringify({
    rerun: 0.1,
    variables: { streaming_now: true, stream_marker: true },
    response: markdownChat(previousChat, true),
    behaviour: { scroll: "end" }
  })

  // If argument is empty, return previous conversation
  if (typedQuery.length === 0) return JSON.stringify({
    response: markdownChat(previousChat, false),
    behaviour: { scroll: "end" }
  })

  // Append new question to chat
  const appendQuery = { role: "user", content: typedQuery }
  const ongoingChat = previousChat.concat(appendQuery)

  // Make API request, write chat file, and start loop
  startStream(apiEndpoint, apiKey, maxTokens, model, systemPrompt, ongoingChat, streamFile, pidStreamFile)
  appendChat(chatFile, appendQuery)

  return JSON.stringify({
    rerun: 0.1,
    variables: { streaming_now: true, stream_marker: true },
    response: markdownChat(ongoingChat)
  })
}

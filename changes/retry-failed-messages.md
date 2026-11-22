# Retry when a message or a generation fails

- When OpenRouter cannot be reached, is busy, or a model fails, Imp now tries again by itself a few times, with short waits, before it tells you. Most of the "could not reach OpenRouter" messages are gone.
- If it still fails, the message to a crew member shows what went wrong in plain words with a **Retry** button. Retry sends it again without saying it twice in the chat.
- Failed pictures, clips, voices and sounds get the same **Retry** button above the stage.
- Error messages say what to do: check the key, add credit, wait a moment or pick another model, instead of showing raw errors.
- A chat answer that never arrives now ends after five minutes with an error you can retry, instead of waiting forever.
- Crew members try a failed generation once more by themselves when the failure was outside Imp.

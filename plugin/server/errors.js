// One error type for every Reddit failure. `kind` decides whether a scan stops or records a gap.
//   credentials  missing or rejected app credentials: stops every tool
//   auth         the token endpoint failed after retries: stops every tool
//   access       the app lacks Data API access: stops every tool
//   rate_limited the rate limit did not clear in time: stops the tool
//   not_found    unknown community or post: recorded as a gap
//   forbidden    private, quarantined or banned community: recorded as a gap
//   upstream     Reddit server error or network failure after retries: recorded as a gap
//   shape        Reddit answered with an unexpected response shape: recorded as a gap
//   input        invalid tool input: stops the tool

export class RedditError extends Error {
  constructor(kind, message, status) {
    super(message)
    this.name = 'RedditError'
    this.kind = kind
    this.status = status
  }

  get fatal() {
    return ['credentials', 'auth', 'access', 'rate_limited', 'input'].includes(this.kind)
  }
}

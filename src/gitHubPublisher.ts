import { Release, Asset } from "gh-release"
import { log, warn, isEmptyOrSpaces } from "./util"
import { basename } from "path"
import { parse as parseUrl } from "url"
import * as mime from "mime"
import { stat } from "fs-extra-p"
import { createReadStream } from "fs"
import { gitHubRequest, HttpError, doGitHubRequest } from "./gitHubRequest"
import { Promise as BluebirdPromise } from "bluebird"
import { ReadStream } from "tty"
import progressStream = require("progress-stream")
import ProgressBar = require("progress")

//noinspection JSUnusedLocalSymbols
const __awaiter = require("./awaiter")

export interface Publisher {
  upload(file: string, artifactName?: string): Promise<any>
}

export interface PublishOptions {
  publish?: "onTag" | "onTagOrDraft" | "always" | "never" | null
  githubToken?: string | null

  draft?: boolean
  prerelease?: boolean
}

export class GitHubPublisher implements Publisher {
  private tag: string
  private _releasePromise: BluebirdPromise<Release>

  private readonly token: string

  get releasePromise(): Promise<Release | null> {
    return this._releasePromise
  }

  constructor(private owner: string, private repo: string, version: string, private options: PublishOptions, private policy: string = "always") {
    if (isEmptyOrSpaces(options.githubToken)) {
      throw new Error("GitHub Personal Access Token is not specified")
    }

    this.token = options.githubToken!

    this.tag = "v" + version
    this._releasePromise = <BluebirdPromise<Release>>this.init()
  }

  private async init(): Promise<Release | null> {
    const createReleaseIfNotExists = this.policy !== "onTagOrDraft"
    // we don't use "Get a release by tag name" because "tag name" means existing git tag, but we draft release and don't create git tag
    const releases = await gitHubRequest<Array<Release>>(`/repos/${this.owner}/${this.repo}/releases`, this.token)
    for (let release of releases) {
      if (release.tag_name === this.tag) {
        if (!release.draft) {
          if (this.policy === "onTag") {
            throw new Error("Release must be a draft")
          }
          else {
            const message = `Release ${this.tag} is not a draft, artifacts will be not published`
            if (this.policy === "always") {
              warn(message)
            }
            else {
              log(message)
            }
            return null
          }
        }
        return release!
      }
    }

    if (createReleaseIfNotExists) {
      log("Release %s doesn't exists, creating one", this.tag)
      return this.createRelease()
    }
    else {
      return null
    }
  }

  async upload(file: string, artifactName?: string): Promise<void> {
    const fileName = artifactName || basename(file)
    const release = await this.releasePromise
    if (release == null) {
      return
    }

    const parsedUrl = parseUrl(release.upload_url.substring(0, release.upload_url.indexOf("{")) + "?name=" + fileName)
    const fileStat = await stat(file)
    let badGatewayCount = 0
    uploadAttempt: for (let i = 0; i < 3; i++) {
      const progressBar = (<ReadStream>process.stdin).isTTY ? new ProgressBar(`Uploading ${fileName} [:bar] :percent :etas`, {
        total: fileStat.size,
        incomplete: " ",
        stream: process.stdout,
        width: 20,
      }) : null

      try {
        return await doGitHubRequest<any>({
          hostname: parsedUrl.hostname,
          path: parsedUrl.path,
          method: "POST",
          headers: {
            Accept: "application/vnd.github.v3+json",
            "User-Agent": "electron-complete-builder",
            "Content-Type": mime.lookup(fileName),
            "Content-Length": fileStat.size
          }
        }, this.token, (request, reject) => {
          const fileInputStream = createReadStream(file)
          fileInputStream.on("error", reject)
          fileInputStream
            .pipe(progressStream({
              length: fileStat.size,
              time: 1000
            }, progress => progressBar == null ? console.log(".") : progressBar.tick(progress.delta)))
            .pipe(request)
        })
      }
      catch (e) {
        if (e instanceof HttpError) {
          if (e.response.statusCode === 422 && e.description != null && e.description.errors != null && e.description.errors[0].code === "already_exists") {
            // delete old artifact and re-upload
            log("Artifact %s already exists, overwrite one", fileName)
            const assets = await gitHubRequest<Array<Asset>>(`/repos/${this.owner}/${this.repo}/releases/${release.id}/assets`, this.token)
            for (let asset of assets) {
              if (asset!.name === fileName) {
                await gitHubRequest<void>(`/repos/${this.owner}/${this.repo}/releases/assets/${asset!.id}`, this.token, null, "DELETE")
                continue uploadAttempt
              }
            }

            log("Artifact %s not found, trying to upload again", fileName)
            continue
          }
          else if (e.response.statusCode === 502 && badGatewayCount++ < 3) {
            continue
          }
        }

        throw e
      }
    }
  }

  private createRelease() {
    return gitHubRequest<Release>(`/repos/${this.owner}/${this.repo}/releases`, this.token, {
      tag_name: this.tag,
      name: this.tag,
      draft: this.options.draft == null || this.options.draft,
      prerelease: this.options.prerelease != null && this.options.prerelease,
    })
  }

  // test only
  async getRelease(): Promise<any> {
    return gitHubRequest<Release>(`/repos/${this.owner}/${this.repo}/releases/${this._releasePromise.value().id}`, this.token)
  }

  //noinspection JSUnusedGlobalSymbols
  async deleteRelease(): Promise<any> {
    if (!this._releasePromise.isFulfilled()) {
      return BluebirdPromise.resolve()
    }

    for (let i = 0; i < 3; i++) {
      try {
        return await gitHubRequest(`/repos/${this.owner}/${this.repo}/releases/${this._releasePromise.value().id}`, this.token, null, "DELETE")
      }
      catch (e) {
        if (e instanceof HttpError && (e.response.statusCode === 405 || e.response.statusCode === 502)) {
          continue
        }

        throw e
      }
    }

    warn(`Cannot delete release ${this._releasePromise.value().id}`)
  }
}
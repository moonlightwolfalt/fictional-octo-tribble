#!/usr/bin/env ruby
# frozen_string_literal: true

# mope_archive.rb — fetch the files of mope.io as the Wayback Machine saw it
# on October 2nd, 2016 (or any other day you pass in).
#
# How it works:
#   1. Ask the Wayback CDX API for every capture under mope.io on that day.
#   2. Download each capture in its raw form (the `id_` flag, so no Wayback
#      toolbar or rewritten links) into a local folder mirroring the site.
#   3. Optionally (--crawl) read the HTML/CSS/JS we got and also fetch any
#      same-site files they reference that weren't captured that exact day;
#      the Wayback Machine serves the closest capture to our timestamp.
#
# Usage:
#   ruby mope_archive.rb                      # 2016-10-02 into ./mope_archive
#   ruby mope_archive.rb --crawl              # also chase referenced assets
#   ruby mope_archive.rb --date 20161015 -o out --delay 1.5
#   ruby mope_archive.rb --list               # just print what's available
#
# Only uses the Ruby standard library.

require "fileutils"
require "json"
require "net/http"
require "optparse"
require "set"
require "uri"

class MopeArchive
  CDX_ENDPOINT = "https://web.archive.org/cdx/search/cdx"
  WAYBACK      = "https://web.archive.org/web"
  USER_AGENT   = "mope-archive-fetcher/1.0 (ruby #{RUBY_VERSION})"
  TEXTUAL      = %r{\A(text/|application/(javascript|x-javascript|json|xml))}.freeze

  Capture = Struct.new(:timestamp, :original, :mimetype, :status, :digest, keyword_init: true)

  def initialize(opts)
    @domain  = opts[:domain]
    @date    = opts[:date]
    @out     = opts[:out]
    @delay   = opts[:delay]
    @retries = opts[:retries]
    @crawl   = opts[:crawl]
    @force   = opts[:force]
    @seen    = Set.new
    @manifest = []
  end

  # --- CDX listing ---------------------------------------------------------

  def captures
    params = {
      url: @domain,
      matchType: "domain",          # mope.io and any subdomains
      from: @date,
      to: @date,
      output: "json",
      fl: "timestamp,original,mimetype,statuscode,digest",
      filter: "statuscode:200",
      collapse: "urlkey"            # one capture per distinct URL
    }
    uri = URI(CDX_ENDPOINT)
    uri.query = URI.encode_www_form(params)
    res = http_get(uri)
    unless res.is_a?(Net::HTTPSuccess)
      abort "CDX query failed (#{res ? "HTTP #{res.code}: #{res.body.to_s[0, 120]}" : 'no response'})"
    end
    body = res.body.to_s
    return [] if body.strip.empty?

    rows = JSON.parse(body)
    header = rows.shift
    rows.map do |row|
      h = header.zip(row).to_h
      Capture.new(timestamp: h["timestamp"], original: h["original"],
                  mimetype: h["mimetype"], status: h["statuscode"], digest: h["digest"])
    end
  end

  # --- downloading ---------------------------------------------------------

  def run(list_only: false)
    caps = captures
    if caps.empty?
      warn "No captures of #{@domain} found on #{@date}. Try another --date."
      return
    end

    puts "Found #{caps.size} capture(s) of #{@domain} on #{@date}:"
    caps.each { |c| puts "  #{c.timestamp}  #{c.mimetype.ljust(24)} #{c.original}" }
    return if list_only

    FileUtils.mkdir_p(@out)
    queue = caps.map { |c| [c.timestamp, c.original] }
    until queue.empty?
      ts, url = queue.shift
      key = normalize(url)
      next if @seen.include?(key)

      @seen << key
      path, type = download(ts, url)
      next unless @crawl && path && type&.match?(TEXTUAL)

      references(File.read(path, mode: "rb"), url).each do |ref|
        queue << [ts, ref] unless @seen.include?(normalize(ref))
      end
    end

    File.write(File.join(@out, "manifest.json"), JSON.pretty_generate(@manifest))
    ok = @manifest.count { |m| m[:saved] }
    puts "\nDone: #{ok}/#{@manifest.size} file(s) saved under #{@out}/ (see manifest.json)."
  end

  def download(timestamp, url)
    dest = local_path(url)
    if File.exist?(dest) && !@force
      puts "  skip   #{url} (already have it)"
      @manifest << { url: url, timestamp: timestamp, path: dest, saved: true, cached: true }
      return [dest, guess_type(dest)]
    end

    res = http_get(URI("#{WAYBACK}/#{timestamp}id_/#{url}"))
    unless res.is_a?(Net::HTTPSuccess)
      puts "  miss   #{url} (#{res ? res.code : 'no response'})"
      @manifest << { url: url, timestamp: timestamp, saved: false, status: res&.code }
      return nil
    end

    FileUtils.mkdir_p(File.dirname(dest))
    File.binwrite(dest, res.body)
    actual_ts = res.uri.to_s[%r{/web/(\d{14})}, 1] || timestamp
    type = res["content-type"].to_s.split(";").first
    puts "  saved  #{url} -> #{dest} (#{res.body.bytesize} bytes)"
    @manifest << { url: url, timestamp: actual_ts, path: dest, content_type: type,
                   bytes: res.body.bytesize, saved: true }
    sleep @delay
    [dest, type]
  end

  # --- helpers -------------------------------------------------------------

  # Pull same-site URLs out of HTML, CSS and JS.
  def references(text, base_url)
    text = text.dup.force_encoding("UTF-8").scrub
    base = URI(base_url)
    found = text.scan(/(?:src|href)\s*=\s*["']([^"'#]+)["']/i).flatten
    found += text.scan(/url\(\s*["']?([^"')]+)["']?\s*\)/i).flatten
    found += text.scan(/["']([^"'\s]+\.(?:png|jpe?g|gif|svg|mp3|ogg|wav|js|css|json|ico|woff2?|ttf))["']/i).flatten

    found.filter_map do |ref|
      next if ref.start_with?("data:", "javascript:", "mailto:", "about:")

      abs = URI.join(base, ref.strip) rescue next
      next unless abs.is_a?(URI::HTTP) && abs.host&.end_with?(@domain)

      abs.fragment = nil
      abs.to_s
    end.uniq
  end

  def local_path(url)
    uri  = URI(url)
    path = uri.path.to_s
    path = "/index.html" if path.empty? || path == "/"
    path += "index.html" if path.end_with?("/")
    path += "__#{uri.query.gsub(/[^\w.-]+/, '_')}" if uri.query
    File.join(@out, uri.host, *path.split("/").reject(&:empty?).map { |p| p.gsub(/[^\w.@-]/, "_") })
  end

  def normalize(url)
    u = URI(url)
    "#{u.host&.sub(/\Awww\./, '')}#{u.path.empty? ? '/' : u.path}#{u.query ? "?#{u.query}" : ''}"
  rescue URI::InvalidURIError
    url
  end

  def guess_type(path)
    case File.extname(path).downcase
    when ".html", ".htm" then "text/html"
    when ".css" then "text/css"
    when ".js" then "application/javascript"
    when ".json" then "application/json"
    else "application/octet-stream"
    end
  end

  # GET with redirects and exponential-backoff retries (the Wayback Machine
  # rate-limits and occasionally hiccups).
  def http_get(uri, redirects: 5)
    attempt = 0
    begin
      attempt += 1
      res = Net::HTTP.start(uri.host, uri.port, use_ssl: uri.scheme == "https",
                            open_timeout: 20, read_timeout: 60) do |http|
        http.request(Net::HTTP::Get.new(uri, "User-Agent" => USER_AGENT))
      end

      if res.is_a?(Net::HTTPRedirection) && redirects.positive?
        return http_get(URI.join(uri, res["location"]), redirects: redirects - 1)
      end
      raise "HTTP #{res.code}" if res.code == "429" || res.code.start_with?("5")

      res.uri ||= uri
      res
    rescue StandardError => e
      if attempt <= @retries
        wait = 2**attempt
        warn "  retry  #{uri} (#{e.message}); waiting #{wait}s"
        sleep wait
        retry
      end
      warn "  fail   #{uri} (#{e.message})"
      nil
    end
  end
end

if $PROGRAM_NAME == __FILE__
  opts = { domain: "mope.io", date: "20161002", out: "mope_archive",
           delay: 1.0, retries: 4, crawl: false, force: false }
  list_only = false

  OptionParser.new do |o|
    o.banner = "Usage: ruby mope_archive.rb [options]"
    o.on("-d", "--date YYYYMMDD", "Day to fetch (default 20161002)") { |v| opts[:date] = v }
    o.on("-o", "--out DIR", "Output directory (default mope_archive)") { |v| opts[:out] = v }
    o.on("--domain HOST", "Domain to fetch (default mope.io)") { |v| opts[:domain] = v }
    o.on("--delay SECONDS", Float, "Pause between downloads (default 1.0)") { |v| opts[:delay] = v }
    o.on("--retries N", Integer, "Retries per request (default 4)") { |v| opts[:retries] = v }
    o.on("-c", "--crawl", "Also fetch same-site files referenced by downloaded pages") { opts[:crawl] = true }
    o.on("-f", "--force", "Re-download files that already exist") { opts[:force] = true }
    o.on("-l", "--list", "Only list the captures, don't download") { list_only = true }
    o.on("-h", "--help") { puts o; exit }
  end.parse!

  abort "--date must look like YYYYMMDD" unless opts[:date].match?(/\A\d{8}\z/)
  MopeArchive.new(opts).run(list_only: list_only)
end

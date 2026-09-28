# Self-hosted fonts

Inter, Bricolage Grotesque, Playfair Display and Archivo: the Latin subset of
each variable font, as Google Fonts serves it. All four are under the SIL Open
Font License 1.1, which allows bundling them with the app.

They live here instead of coming from `next/font/google` because that loader
downloads them from Google on every build. Its parser expects each font file
address to end in an extension like `.woff2`, and Google sometimes answers
without one. The build then dies with
`An error occurred in next/font ... Cannot read properties of null (reading '1')`.
That happened on CI and on Vercel for several pull requests in one afternoon,
none of which touched fonts. Loading the files from here takes the network
out of the build.

To refresh one, download the Latin `.woff2` that
`https://fonts.googleapis.com/css2?family=<Family>:wght@<range>` points at
(send a desktop browser user agent), and replace the file here.

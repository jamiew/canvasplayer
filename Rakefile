# "Deployment" using rake
# Adopted from Scott Kyle's Rakefile
# http://github.com/appden/appden.github.com/blob/master/Rakefile

task :default => :build
 
desc 'Build'
task :build do
  # this does nothing, but could potentially do something.
end

desc 'Build and deploy'
task :deploy => :build do
  sh 'rsync -rtzh --progress --delete . jamiew@txd:~/web/public/canvasplayer2'
end

desc "Run tests"
task :test do
  STDERR.puts "This does nothing."
end
